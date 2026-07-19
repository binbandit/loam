//! Normalized vault watching (D7, §5.6): notify + debouncer with a polling
//! fallback, tolerant of sync-tool tempfile churn, with app/external origin
//! classification by content hash.
//!
//! Architecture: raw backend events flow through a **pure normalization
//! pipeline** (`normalize`) that is fully replay-testable, then through origin
//! classification against the app-write registry. The live backends
//! (`Backend::Native`, `Backend::Polling`) only produce raw traces.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::RecursiveMode;
use notify_debouncer_full::{DebounceEventResult, new_debouncer, new_debouncer_opt};
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use super::note::ContentHash;
use super::writer::{ChangeOrigin, TEMP_SUFFIX};

/// §5.6: polling fallback interval for filesystems without native events.
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Default debounce for native events; §5.6 requires external edits visible in
/// under one second, so debounce must stay well below it.
pub const DEBOUNCE: Duration = Duration::from_millis(200);
/// How long an app write remains recognizable for echo suppression.
const APP_WRITE_TTL: Duration = Duration::from_secs(5);

/// Normalized vault event (`vault://file-changed{path,kind,origin}` §5.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEvent {
    pub path: String,
    pub kind: EventKind,
    pub origin: ChangeOrigin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case", tag = "type")]
pub enum EventKind {
    Created,
    Modified,
    Renamed { from: String },
    Deleted,
}

/// Raw backend event, before normalization. Pure data — traces of these are
/// replayed in tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawEvent {
    Created(String),
    Modified(String),
    Deleted(String),
    Renamed { from: String, to: String },
}

/// Temp/churn patterns sync tools and editors produce (§5.6): our own writer
/// temps plus common sync/editor artifacts. A path matching any of these is
/// never surfaced.
pub fn is_ignorable_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.ends_with(TEMP_SUFFIX)
        || name.ends_with(".tmp")
        || name.ends_with(".swp")
        || name.ends_with('~')
        || name.ends_with(".partial")
        || name.starts_with(".syncthing.")
        || name.starts_with(".#")
        || name == ".DS_Store"
}

/// Pure normalization: drop churn, resolve temp→final rename patterns to the
/// final logical change, coalesce repeated events per path (last state wins,
/// with create/delete algebra), and preserve rename pairing.
pub fn normalize(trace: &[RawEvent]) -> Vec<VaultEvent> {
    #[derive(Clone, Debug)]
    enum State {
        Created,
        Modified,
        Deleted,
        Renamed { from: String },
    }

    // Insertion-ordered accumulation per final path.
    let mut order: Vec<String> = Vec::new();
    let mut states: HashMap<String, State> = HashMap::new();
    fn upsert(
        states: &mut HashMap<String, State>,
        order: &mut Vec<String>,
        path: &str,
        next: State,
    ) {
        if !states.contains_key(path) {
            order.push(path.to_string());
        }
        let merged = match (states.get(path), &next) {
            // A created-then-modified file is still just "created".
            (Some(State::Created), State::Modified) => State::Created,
            // Created then deleted within one trace: transient, drop later.
            (Some(State::Created), State::Deleted) => State::Deleted,
            _ => next.clone(),
        };
        states.insert(path.to_string(), merged);
    }

    let mut transient_creates: Vec<String> = Vec::new();
    for event in trace {
        match event {
            RawEvent::Created(path) if !is_ignorable_path(path) => {
                upsert(&mut states, &mut order, path, State::Created);
            }
            RawEvent::Modified(path) if !is_ignorable_path(path) => {
                upsert(&mut states, &mut order, path, State::Modified);
            }
            RawEvent::Deleted(path) if !is_ignorable_path(path) => {
                if matches!(states.get(path.as_str()), Some(State::Created)) {
                    transient_creates.push(path.clone());
                }
                upsert(&mut states, &mut order, path, State::Deleted);
            }
            RawEvent::Renamed { from, to } => {
                match (is_ignorable_path(from), is_ignorable_path(to)) {
                    // Temp -> final: the atomic-save pattern. The final file
                    // logically changed (or appeared).
                    (true, false) => upsert(&mut states, &mut order, to, State::Modified),
                    // Final -> temp (editors moving originals aside): treat as
                    // a modification-in-progress of the original; the paired
                    // temp->final rename that follows will confirm it.
                    (false, true) => upsert(&mut states, &mut order, from, State::Modified),
                    (true, true) => {}
                    (false, false) => {
                        upsert(
                            &mut states,
                            &mut order,
                            to,
                            State::Renamed { from: from.clone() },
                        );
                    }
                }
            }
            _ => {}
        }
    }

    order
        .into_iter()
        .filter_map(|path| {
            let state = states.get(&path)?;
            // A file created and deleted inside one debounce window never
            // logically existed.
            if transient_creates.contains(&path) && matches!(state, State::Deleted) {
                return None;
            }
            let kind = match state {
                State::Created => EventKind::Created,
                State::Modified => EventKind::Modified,
                State::Deleted => EventKind::Deleted,
                State::Renamed { from } => EventKind::Renamed { from: from.clone() },
            };
            Some(VaultEvent {
                path,
                kind,
                origin: ChangeOrigin::External, // classified next stage
            })
        })
        .collect()
}

/// Registry of recent app writes for echo suppression (AC2). The writer's
/// event sink records here; watcher events whose current content hash matches
/// a fresh registration are echoes of our own writes.
#[derive(Clone, Default)]
pub struct AppWriteRegistry {
    inner: Arc<Mutex<HashMap<String, (ContentHash, Instant)>>>,
}

impl AppWriteRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&self, path: &str, hash: ContentHash) {
        self.inner
            .lock()
            .expect("registry lock")
            .insert(path.to_string(), (hash, Instant::now()));
    }

    /// True when `current_hash` matches a fresh app write for `path`.
    ///
    /// Deliberately NON-consuming: FSEvents can split one logical write into
    /// several raw batches (or replay pre-arm history late), and consuming on
    /// first match misclassified the follow-up batch as External. Entries
    /// expire by TTL instead — safe, because while an entry is fresh a
    /// matching hash means the on-disk content is byte-identical to what the
    /// app itself wrote, so suppression can never hide real information. A
    /// genuine external edit changes the hash and is never suppressed.
    pub fn is_app_echo(&self, path: &str, current_hash: &ContentHash) -> bool {
        let mut inner = self.inner.lock().expect("registry lock");
        match inner.get(path) {
            Some((hash, at)) if hash == current_hash && at.elapsed() < APP_WRITE_TTL => true,
            Some((_, at)) if at.elapsed() >= APP_WRITE_TTL => {
                inner.remove(path);
                false
            }
            _ => false,
        }
    }
}

/// Classify origins and suppress app echoes: an event whose on-disk content
/// matches a fresh app write is dropped (the writer already emitted the
/// App-origin event); everything else is External.
pub fn classify(
    canonical_root: &Path,
    events: Vec<VaultEvent>,
    registry: &AppWriteRegistry,
) -> Vec<VaultEvent> {
    events
        .into_iter()
        .filter_map(|event| {
            if matches!(event.kind, EventKind::Created | EventKind::Modified) {
                let disk = std::fs::read(canonical_root.join(&event.path)).ok();
                if let Some(bytes) = disk
                    && registry.is_app_echo(&event.path, &ContentHash::of(&bytes))
                {
                    return None;
                }
            }
            Some(event)
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// Native OS events (FSEvents/inotify/ReadDirectoryChangesW).
    Native,
    /// §5.6 polling fallback for network mounts and event-less filesystems.
    Polling(Duration),
}

/// A running watcher; dropping it stops watching.
pub struct VaultWatcher {
    _debouncer: Box<dyn std::any::Any + Send>,
}

#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    #[error("failed to start the vault watcher: {0}")]
    Notify(#[from] notify::Error),
}

/// Start watching `canonical_root`, delivering normalized, origin-classified
/// events to `on_events`.
pub fn start_watching(
    canonical_root: &Path,
    backend: Backend,
    registry: AppWriteRegistry,
    on_events: impl Fn(Vec<VaultEvent>) + Send + 'static,
) -> Result<VaultWatcher, WatchError> {
    let root = canonical_root.to_path_buf();
    let handler = move |result: DebounceEventResult| {
        let Ok(batch) = result else { return };
        let trace = to_raw_trace(&root, &batch);
        let events = classify(&root, normalize(&trace), &registry);
        if !events.is_empty() {
            on_events(events);
        }
    };

    match backend {
        Backend::Native => {
            let mut debouncer = new_debouncer(DEBOUNCE, None, handler)?;
            debouncer.watch(canonical_root, RecursiveMode::Recursive)?;
            Ok(VaultWatcher {
                _debouncer: Box::new(debouncer),
            })
        }
        Backend::Polling(interval) => {
            let config = notify::Config::default()
                .with_poll_interval(interval)
                .with_compare_contents(true);
            let mut debouncer = new_debouncer_opt::<_, notify::PollWatcher, _>(
                DEBOUNCE,
                None,
                handler,
                notify_debouncer_full::RecommendedCache::new(),
                config,
            )?;
            debouncer.watch(canonical_root, RecursiveMode::Recursive)?;
            Ok(VaultWatcher {
                _debouncer: Box::new(debouncer),
            })
        }
    }
}

/// Convert a debounced notify batch into the pure raw trace, with paths made
/// vault-relative and NFC-normalized.
fn to_raw_trace(root: &Path, batch: &[notify_debouncer_full::DebouncedEvent]) -> Vec<RawEvent> {
    use notify::EventKind as NK;
    use notify::event::{ModifyKind, RenameMode};

    let rel = |p: &PathBuf| -> Option<String> {
        let relative = p.strip_prefix(root).ok()?;
        let normalized: String = relative
            .to_string_lossy()
            .replace('\\', "/")
            .nfc()
            .collect();
        // Events for the vault root itself (empty relative path) carry no
        // file-level meaning; FSEvents emits them around watch start.
        if normalized.is_empty() {
            return None;
        }
        Some(normalized)
    };

    let mut trace = Vec::new();
    for event in batch {
        match &event.kind {
            NK::Create(_) => {
                if let Some(path) = event.paths.first().and_then(rel) {
                    trace.push(RawEvent::Created(path));
                }
            }
            NK::Remove(_) => {
                if let Some(path) = event.paths.first().and_then(rel) {
                    trace.push(RawEvent::Deleted(path));
                }
            }
            NK::Modify(ModifyKind::Name(RenameMode::Both)) => {
                if let (Some(from), Some(to)) = (
                    event.paths.first().and_then(rel),
                    event.paths.get(1).and_then(rel),
                ) {
                    trace.push(RawEvent::Renamed { from, to });
                }
            }
            NK::Modify(ModifyKind::Name(RenameMode::From)) => {
                if let Some(path) = event.paths.first().and_then(rel) {
                    trace.push(RawEvent::Deleted(path));
                }
            }
            NK::Modify(ModifyKind::Name(RenameMode::To)) => {
                if let Some(path) = event.paths.first().and_then(rel) {
                    trace.push(RawEvent::Created(path));
                }
            }
            NK::Modify(_) => {
                if let Some(path) = event.paths.first().and_then(rel) {
                    trace.push(RawEvent::Modified(path));
                }
            }
            _ => {}
        }
    }
    trace
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::super::writer::{EventSink, FileChanged, note_write};
    use super::*;

    fn vault() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("vault");
        let root = dir.path().canonicalize().expect("canonical");
        (dir, root)
    }

    fn channel_watcher(
        root: &Path,
        backend: Backend,
        registry: AppWriteRegistry,
    ) -> (VaultWatcher, mpsc::Receiver<Vec<VaultEvent>>) {
        let (tx, rx) = mpsc::channel();
        let watcher = start_watching(root, backend, registry, move |events| {
            tx.send(events).ok();
        })
        .expect("watcher starts");
        (watcher, rx)
    }

    /// FSEvents can replay pre-arm history (seed writes) after the watcher
    /// starts, especially on slow CI machines: drain it before acting.
    fn drain(rx: &mpsc::Receiver<Vec<VaultEvent>>, settle: Duration) {
        let deadline = Instant::now() + settle;
        while Instant::now() < deadline {
            if rx.recv_timeout(Duration::from_millis(100)).is_err() {
                // One quiet window is enough.
                return;
            }
        }
    }

    /// AC3: the classic atomic-save trace (temp write + rename over the real
    /// file) normalizes to exactly one logical modification.
    #[test]
    fn tempfile_save_traces_normalize_to_the_final_change() {
        let trace = vec![
            RawEvent::Created(".Note.md.1234.loamtmp".into()),
            RawEvent::Modified(".Note.md.1234.loamtmp".into()),
            RawEvent::Renamed {
                from: ".Note.md.1234.loamtmp".into(),
                to: "Note.md".into(),
            },
        ];
        assert_eq!(
            normalize(&trace),
            vec![VaultEvent {
                path: "Note.md".into(),
                kind: EventKind::Modified,
                origin: ChangeOrigin::External,
            }]
        );

        // Syncthing-style churn: temp created, written, renamed into place.
        let sync = vec![
            RawEvent::Created(".syncthing.Note.md.tmp".into()),
            RawEvent::Modified(".syncthing.Note.md.tmp".into()),
            RawEvent::Renamed {
                from: ".syncthing.Note.md.tmp".into(),
                to: "Note.md".into(),
            },
        ];
        assert_eq!(normalize(&sync).len(), 1);

        // Pure churn with no final file: nothing surfaces.
        let noise = vec![
            RawEvent::Created("x.tmp".into()),
            RawEvent::Deleted("x.tmp".into()),
            RawEvent::Modified(".DS_Store".into()),
        ];
        assert!(normalize(&noise).is_empty());
    }

    /// AC4: rename pairing preserves both endpoints; coalescing keeps
    /// create+modify as one Created; transient create+delete vanishes.
    #[test]
    fn rename_pairing_and_coalescing() {
        let trace = vec![
            RawEvent::Renamed {
                from: "Old.md".into(),
                to: "New.md".into(),
            },
            RawEvent::Created("Fresh.md".into()),
            RawEvent::Modified("Fresh.md".into()),
            RawEvent::Created("Blink.md".into()),
            RawEvent::Deleted("Blink.md".into()),
        ];
        let events = normalize(&trace);
        assert_eq!(
            events,
            vec![
                VaultEvent {
                    path: "New.md".into(),
                    kind: EventKind::Renamed {
                        from: "Old.md".into()
                    },
                    origin: ChangeOrigin::External,
                },
                VaultEvent {
                    path: "Fresh.md".into(),
                    kind: EventKind::Created,
                    origin: ChangeOrigin::External,
                },
            ]
        );
    }

    /// AC1: a real external edit surfaces as one normalized event in <1 s.
    #[test]
    fn external_edit_appears_within_one_second() {
        let (_dir, root) = vault();
        std::fs::write(root.join("Note.md"), "v1").expect("seed");
        let (_watcher, rx) = channel_watcher(&root, Backend::Native, AppWriteRegistry::new());
        // Arm, then drain any replayed pre-arm history (seed write).
        std::thread::sleep(Duration::from_millis(300));
        drain(&rx, Duration::from_secs(2));

        let started = Instant::now();
        std::fs::write(root.join("Note.md"), "external v2").expect("external edit");
        let events = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("event arrives");
        let elapsed = started.elapsed();

        assert_eq!(events.len(), 1, "one normalized event: {events:?}");
        assert_eq!(events[0].path, "Note.md");
        // FSEvents may coalesce the seed-create with the edit into Created.
        assert!(
            matches!(events[0].kind, EventKind::Created | EventKind::Modified),
            "logical change kind: {events:?}"
        );
        assert_eq!(events[0].origin, ChangeOrigin::External);
        assert!(
            elapsed < Duration::from_secs(1),
            "external edit took {elapsed:?} (budget <1s)"
        );
    }

    /// AC2: an app write (through the atomic writer, registered in the
    /// app-write registry) is not echoed as an external event.
    #[test]
    fn app_writes_are_not_echoed_as_external() {
        let (_dir, root) = vault();
        std::fs::write(root.join("Note.md"), "v1").expect("seed");
        let registry = AppWriteRegistry::new();
        let (_watcher, rx) = channel_watcher(&root, Backend::Native, registry.clone());
        std::thread::sleep(Duration::from_millis(300));
        drain(&rx, Duration::from_secs(2));

        // The shell wires the writer's sink to the registry like this:
        struct RegistrySink(AppWriteRegistry);
        impl EventSink for RegistrySink {
            fn file_changed(&self, event: FileChanged) {
                self.0.record(&event.relative_path, event.hash);
            }
        }
        let sink = RegistrySink(registry);
        let base = ContentHash::of(b"v1");
        note_write(&root, "Note.md", "app v2", Some(&base), &sink).expect("app write");

        // The echo window: no external event may arrive for the app write.
        match rx.recv_timeout(Duration::from_secs(2)) {
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Ok(events) => panic!("app write echoed as external: {events:?}"),
            Err(other) => panic!("watcher died: {other:?}"),
        }

        // A subsequent genuine external edit still comes through.
        std::fs::write(root.join("Note.md"), "external v3").expect("external");
        let events = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("external event after app write");
        assert_eq!(events[0].origin, ChangeOrigin::External);
    }

    /// AC5: the polling backend detects changes within its interval budget.
    #[test]
    fn polling_fallback_detects_changes() {
        let (_dir, root) = vault();
        std::fs::write(root.join("Note.md"), "v1").expect("seed");
        let (_watcher, rx) = channel_watcher(
            &root,
            Backend::Polling(Duration::from_millis(500)),
            AppWriteRegistry::new(),
        );
        std::thread::sleep(Duration::from_millis(600));
        drain(&rx, Duration::from_secs(2));

        let started = Instant::now();
        std::fs::write(root.join("Note.md"), "poll v2").expect("edit");
        let events = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("poll event arrives");
        let elapsed = started.elapsed();
        assert_eq!(events[0].path, "Note.md");
        // §5.6 budget: within the 2 s production interval (test polls faster;
        // assert against the production budget with debounce headroom).
        assert!(
            elapsed < POLL_INTERVAL + DEBOUNCE + Duration::from_millis(500),
            "polling detection took {elapsed:?}"
        );
    }
}
