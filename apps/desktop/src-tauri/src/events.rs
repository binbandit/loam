//! Typed vault event bridge (§5.4, LOA-60): forwards normalized core events
//! to the matching vault window only, with per-vault monotonic sequence
//! numbers for ordering diagnostics. Bridge lifetime follows window/vault
//! lifetime — replaced on reopen, disposed on close, never duplicated.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use loam_core::ipc::{
    ConflictPayload, EVENT_CONFLICT, EVENT_FILE_CHANGED, EVENT_INDEX_PROGRESS, EventEnvelope,
    IndexProgress, LoamError, VaultEvent,
};
use loam_core::vault::{self, AppWriteRegistry, Backend, EventSink, FileChanged};
use serde::Serialize;
use tauri::{AppHandle, Emitter as _, Runtime};

/// One vault's live bridge: watcher + app-write registry + sequence counter.
struct Bridge {
    vault_id: String,
    window_label: String,
    seq: Arc<AtomicU64>,
    registry: AppWriteRegistry,
    // Dropping this stops the native watcher — disposal IS the unsubscribe.
    _watcher: vault::VaultWatcher,
}

/// Managed state: bridges keyed by window label (one vault per window).
#[derive(Default)]
pub struct EventBridges {
    inner: Mutex<HashMap<String, Bridge>>,
}

fn emit_enveloped<R: Runtime, T: Serialize + Clone>(
    app: &AppHandle<R>,
    window_label: &str,
    seq: &AtomicU64,
    vault_id: &str,
    channel: &str,
    payload: T,
) {
    let envelope = EventEnvelope {
        seq: seq.fetch_add(1, Ordering::SeqCst),
        vault_id: vault_id.to_string(),
        payload,
    };
    // Scoped delivery: only the matching vault window receives the event.
    if let Err(error) = app.emit_to(window_label, channel, envelope) {
        tracing::warn!(target: "loam::events", channel, window_label, %error, "emit failed");
    }
}

/// Start (or replace) the bridge for a vault window. Replacing drops the old
/// watcher first, so reopening a vault can never double-subscribe.
pub fn start_bridge<R: Runtime>(
    app: &AppHandle<R>,
    bridges: &EventBridges,
    vault_id: &str,
    canonical_root: &Path,
    window_label: &str,
) -> Result<(), LoamError> {
    let registry = AppWriteRegistry::new();
    let seq = Arc::new(AtomicU64::new(0));

    let emit_app = app.clone();
    let emit_seq = seq.clone();
    let emit_vault = vault_id.to_string();
    let emit_label = window_label.to_string();
    let watcher = vault::start_watching(
        canonical_root,
        Backend::Native,
        registry.clone(),
        move |events| {
            for event in events {
                emit_enveloped(
                    &emit_app,
                    &emit_label,
                    &emit_seq,
                    &emit_vault,
                    EVENT_FILE_CHANGED,
                    VaultEvent::from(event),
                );
            }
        },
    )
    .map_err(|error| LoamError::Internal {
        detail: format!("watcher failed to start: {error}"),
    })?;

    let bridge = Bridge {
        vault_id: vault_id.to_string(),
        window_label: window_label.to_string(),
        seq,
        registry,
        _watcher: watcher,
    };
    // Insert replaces any previous bridge for this window; the old Bridge
    // drops here, stopping its watcher (AC2).
    bridges
        .inner
        .lock()
        .expect("bridges lock")
        .insert(window_label.to_string(), bridge);
    Ok(())
}

/// Dispose the bridge for a closing window (AC3). Returns the vault id that
/// was bridged, so callers can also drop the capability root.
pub fn stop_bridge_for_window(bridges: &EventBridges, window_label: &str) -> Option<String> {
    bridges
        .inner
        .lock()
        .expect("bridges lock")
        .remove(window_label)
        .map(|bridge| bridge.vault_id)
}

/// Number of live bridges (tests/diagnostics).
pub fn live_bridges(bridges: &EventBridges) -> usize {
    bridges.inner.lock().expect("bridges lock").len()
}

/// The app-write registry for a vault (echo suppression wiring for writes).
pub fn registry_for(bridges: &EventBridges, vault_id: &str) -> Option<AppWriteRegistry> {
    bridges
        .inner
        .lock()
        .expect("bridges lock")
        .values()
        .find(|bridge| bridge.vault_id == vault_id)
        .map(|bridge| bridge.registry.clone())
}

/// Emit `vault://index-progress` for a vault (index pipeline wiring).
pub fn emit_index_progress<R: Runtime>(
    app: &AppHandle<R>,
    bridges: &EventBridges,
    vault_id: &str,
    progress: IndexProgress,
) {
    let inner = bridges.inner.lock().expect("bridges lock");
    if let Some(bridge) = inner.values().find(|b| b.vault_id == vault_id) {
        emit_enveloped(
            app,
            &bridge.window_label,
            &bridge.seq,
            vault_id,
            EVENT_INDEX_PROGRESS,
            progress,
        );
    }
}

/// Emit `vault://conflict` for a vault (conflict flow wiring).
pub fn emit_conflict<R: Runtime>(
    app: &AppHandle<R>,
    bridges: &EventBridges,
    vault_id: &str,
    payload: ConflictPayload,
) {
    let inner = bridges.inner.lock().expect("bridges lock");
    if let Some(bridge) = inner.values().find(|b| b.vault_id == vault_id) {
        emit_enveloped(
            app,
            &bridge.window_label,
            &bridge.seq,
            vault_id,
            EVENT_CONFLICT,
            payload,
        );
    }
}

/// Event sink for the atomic writer: records the app write for watcher echo
/// suppression AND forwards the app-origin event to the vault's window.
pub struct BridgeSink<R: Runtime> {
    app: AppHandle<R>,
    vault_id: String,
}

impl<R: Runtime> BridgeSink<R> {
    pub fn new(app: AppHandle<R>, vault_id: impl Into<String>) -> Self {
        Self {
            app,
            vault_id: vault_id.into(),
        }
    }
}

impl<R: Runtime> EventSink for BridgeSink<R> {
    fn file_changed(&self, event: FileChanged) {
        use tauri::Manager as _;
        let bridges = self.app.state::<EventBridges>();
        let inner = bridges.inner.lock().expect("bridges lock");
        let Some(bridge) = inner.values().find(|b| b.vault_id == self.vault_id) else {
            return;
        };
        bridge
            .registry
            .record(&event.relative_path, event.hash.clone());
        let payload = VaultEvent {
            path: loam_core::ipc::VaultPath(event.relative_path.clone()),
            kind: match event.kind {
                vault::ChangeKind::Created => loam_core::ipc::EventKind::Created,
                vault::ChangeKind::Modified => loam_core::ipc::EventKind::Modified,
            },
            origin: loam_core::ipc::ChangeOrigin::App,
        };
        emit_enveloped(
            &self.app,
            &bridge.window_label,
            &bridge.seq,
            &self.vault_id,
            EVENT_FILE_CHANGED,
            payload,
        );
    }
}

// LOA-60 acceptance tests: real bridges over the mock runtime, deterministic
// emission via the write sink and the progress/conflict helpers.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{main_webview_on, mock_app};
    use loam_core::ipc::VaultPath;
    use std::sync::Mutex as StdMutex;
    use tauri::{Listener as _, Manager as _};

    struct Opened {
        app: tauri::App<tauri::test::MockRuntime>,
        vault: tempfile::TempDir,
        id: String,
        label: String,
    }

    fn open_vault(
        app: &tauri::App<tauri::test::MockRuntime>,
    ) -> (tempfile::TempDir, String, String) {
        let vault = tempfile::tempdir().expect("vault");
        std::fs::write(vault.path().join("note.md"), "v1").expect("seed");
        let handle = app.handle().clone();
        let info = crate::vault_open(handle.clone(), vault.path().to_string_lossy().into_owned())
            .expect("vault_open");
        let key = crate::windows::vault_key(&vault.path().canonicalize().expect("canonical"));
        let label = crate::windows::label_for_key(&handle, &key).expect("window label");
        (vault, info.id, label)
    }

    fn opened() -> Opened {
        let app = mock_app();
        let _webview = main_webview_on(&app);
        let (vault, id, label) = open_vault(&app);
        Opened {
            app,
            vault,
            id,
            label,
        }
    }

    fn capture_on(
        app: &tauri::App<tauri::test::MockRuntime>,
        label: &str,
        channel: &'static str,
    ) -> Arc<StdMutex<Vec<String>>> {
        let seen: Arc<StdMutex<Vec<String>>> = Arc::default();
        let sink = seen.clone();
        app.get_webview_window(label)
            .expect("window")
            .listen(channel, move |event| {
                sink.lock()
                    .expect("capture")
                    .push(event.payload().to_string());
            });
        seen
    }

    fn app_write(
        opened_app: &tauri::App<tauri::test::MockRuntime>,
        vault: &tempfile::TempDir,
        id: &str,
    ) {
        let registry = opened_app.state::<crate::commands::VaultRegistry>();
        let base = loam_core::vault::ContentHash::of(
            &std::fs::read(vault.path().join("note.md")).expect("read"),
        );
        crate::commands::note_write(
            opened_app.handle().clone(),
            registry,
            id.to_string(),
            "note.md".into(),
            format!("edit {}", loam_core::vault::ContentHash::of(b"x").as_str()),
            Some(base.as_str().to_string()),
        )
        .expect("write");
    }

    /// AC1: with two vaults open, an event reaches only the matching
    /// vault's window.
    #[test]
    fn only_the_matching_vault_window_receives_events() {
        let first = opened();
        let (vault_b, id_b, label_b) = open_vault(&first.app);

        let seen_a = capture_on(&first.app, &first.label, EVENT_FILE_CHANGED);
        let seen_b = capture_on(&first.app, &label_b, EVENT_FILE_CHANGED);

        app_write(&first.app, &first.vault, &first.id);
        assert_eq!(seen_a.lock().expect("a").len(), 1, "vault A got its event");
        assert!(seen_b.lock().expect("b").is_empty(), "vault B got nothing");

        app_write(&first.app, &vault_b, &id_b);
        assert_eq!(seen_a.lock().expect("a").len(), 1);
        assert_eq!(seen_b.lock().expect("b").len(), 1);
    }

    /// AC2: reopening a vault replaces its bridge — events never duplicate.
    #[test]
    fn reopening_never_duplicates_subscriptions() {
        let opened = opened();
        let bridges = opened.app.state::<EventBridges>();
        assert_eq!(live_bridges(&bridges), 1);

        // Reopen the same vault (focuses the existing window, restarts the
        // bridge in place).
        crate::vault_open(
            opened.app.handle().clone(),
            opened.vault.path().to_string_lossy().into_owned(),
        )
        .expect("reopen");
        assert_eq!(live_bridges(&bridges), 1, "replaced, not added");

        let seen = capture_on(&opened.app, &opened.label, EVENT_FILE_CHANGED);
        app_write(&opened.app, &opened.vault, &opened.id);
        assert_eq!(
            seen.lock().expect("seen").len(),
            1,
            "exactly one event after reopen"
        );
    }

    /// AC3: closing the window disposes the bridge and the capability root.
    #[test]
    fn closing_a_window_disposes_listeners() {
        let opened = opened();
        let bridges = opened.app.state::<EventBridges>();
        assert_eq!(live_bridges(&bridges), 1);

        let key =
            crate::windows::vault_key(&opened.vault.path().canonicalize().expect("canonical"));
        opened
            .app
            .get_webview_window(&opened.label)
            .expect("window")
            .destroy()
            .expect("destroy");
        crate::windows::on_vault_window_destroyed(&opened.app.handle().clone(), &key);

        assert_eq!(live_bridges(&bridges), 0, "bridge disposed");
        let registry = opened.app.state::<crate::commands::VaultRegistry>();
        assert!(
            registry.root_of(&opened.id).is_err(),
            "capability root dropped with the window"
        );
    }

    /// AC4: emitted payloads deserialize as the exact generated contract
    /// types (envelope + payload).
    #[test]
    fn payloads_match_the_contract_types() {
        let opened = opened();
        let seen = capture_on(&opened.app, &opened.label, EVENT_FILE_CHANGED);
        app_write(&opened.app, &opened.vault, &opened.id);

        let raw = seen.lock().expect("seen")[0].clone();
        let envelope: EventEnvelope<VaultEvent> =
            serde_json::from_str(&raw).expect("payload IS the contract type");
        assert_eq!(envelope.vault_id, opened.id);
        assert_eq!(envelope.payload.path, VaultPath("note.md".into()));
        assert_eq!(
            envelope.payload.origin,
            loam_core::ipc::ChangeOrigin::App,
            "write sink emits app origin"
        );

        let progress_seen = capture_on(&opened.app, &opened.label, EVENT_INDEX_PROGRESS);
        emit_index_progress(
            &opened.app.handle().clone(),
            &opened.app.state::<EventBridges>(),
            &opened.id,
            IndexProgress { done: 1, total: 2 },
        );
        let raw = progress_seen.lock().expect("seen")[0].clone();
        let envelope: EventEnvelope<IndexProgress> =
            serde_json::from_str(&raw).expect("progress contract type");
        assert_eq!(envelope.payload, IndexProgress { done: 1, total: 2 });

        let conflict_seen = capture_on(&opened.app, &opened.label, EVENT_CONFLICT);
        emit_conflict(
            &opened.app.handle().clone(),
            &opened.app.state::<EventBridges>(),
            &opened.id,
            ConflictPayload {
                path: VaultPath("note.md".into()),
                mine: "m".into(),
                disk: "d".into(),
                base: None,
                disk_hash: loam_core::ipc::HashHex("ab".into()),
            },
        );
        let raw = conflict_seen.lock().expect("seen")[0].clone();
        let envelope: EventEnvelope<ConflictPayload> =
            serde_json::from_str(&raw).expect("conflict contract type");
        assert_eq!(envelope.payload.path, VaultPath("note.md".into()));
    }

    /// AC5: rapid progress events arrive in order with strictly increasing
    /// sequence numbers.
    #[test]
    fn rapid_progress_events_remain_ordered() {
        let opened = opened();
        let seen = capture_on(&opened.app, &opened.label, EVENT_INDEX_PROGRESS);
        let bridges = opened.app.state::<EventBridges>();
        for done in 0..100u64 {
            emit_index_progress(
                &opened.app.handle().clone(),
                &bridges,
                &opened.id,
                IndexProgress { done, total: 100 },
            );
        }
        let raw = seen.lock().expect("seen").clone();
        assert_eq!(raw.len(), 100);
        let envelopes: Vec<EventEnvelope<IndexProgress>> = raw
            .iter()
            .map(|payload| serde_json::from_str(payload).expect("contract type"))
            .collect();
        assert!(
            envelopes.windows(2).all(|w| w[0].seq < w[1].seq),
            "sequence numbers strictly increase"
        );
        assert!(
            envelopes
                .windows(2)
                .all(|w| w[0].payload.done < w[1].payload.done),
            "payload order preserved"
        );
    }
}
