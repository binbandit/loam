//! Atomic note writes with conflict detection (§5.4, §5.6 — the T-A worked
//! example): same-directory tempfile → write → fsync → rename → directory
//! fsync (POSIX). A crash at any point leaves either the old content or the
//! new content, never a partial file. A stale `base_hash` returns
//! `Conflict { disk_hash }` and leaves the disk untouched.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use super::note::{ContentHash, NoteError, resolve_in_vault};

/// Suffix for in-flight write temp files. Also the pattern the watcher
/// (LOA-38) ignores and `clean_stale_temps` sweeps.
pub const TEMP_SUFFIX: &str = ".loamtmp";

/// Normalized change event (§5.4 `vault://file-changed`). The watcher (LOA-38)
/// merges these app-origin events with external filesystem events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChanged {
    pub relative_path: String,
    pub kind: ChangeKind,
    pub origin: ChangeOrigin,
    pub hash: ContentHash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeKind {
    Created,
    Modified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeOrigin {
    App,
    External,
}

/// Sink for app-origin change events. The shell wires this to the IPC event
/// channel; the watcher uses it to classify origins.
pub trait EventSink: Send + Sync {
    fn file_changed(&self, event: FileChanged);
}

/// Event sink that drops events (tests, headless tools).
pub struct NullSink;

impl EventSink for NullSink {
    fn file_changed(&self, _event: FileChanged) {}
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub relative_path: String,
    pub hash: ContentHash,
    pub kind: ChangeKind,
}

#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    /// §5.4: stale `base_hash` — the disk changed since the caller read it.
    /// The disk is left untouched; `disk_hash` lets the UI open the merge path.
    #[error("the note changed on disk since it was read")]
    Conflict { disk_hash: ContentHash },
    #[error("cannot create: the file already exists")]
    AlreadyExists,
    #[error(transparent)]
    Path(#[from] NoteError),
    #[error("failed to write the note: {0}")]
    Io(#[from] std::io::Error),
}

/// Write `content` to `relative` inside the vault.
///
/// - `base_hash: Some(h)` — modify an existing note; `h` must match the
///   current disk content or `Conflict { disk_hash }` is returned.
/// - `base_hash: None` — create a new note; fails with `AlreadyExists` if the
///   path is already occupied.
pub fn note_write(
    canonical_root: &Path,
    relative: &str,
    content: &str,
    base_hash: Option<&ContentHash>,
    sink: &dyn EventSink,
) -> Result<WriteResult, WriteError> {
    note_write_with_hook(canonical_root, relative, content, base_hash, sink, || {})
}

/// Same as [`note_write`] with a test-only fault hook invoked between the
/// durable temp write and the rename — the crash window the §5.6 guarantee is
/// about. Production callers pass a no-op via [`note_write`].
pub fn note_write_with_hook(
    canonical_root: &Path,
    relative: &str,
    content: &str,
    base_hash: Option<&ContentHash>,
    sink: &dyn EventSink,
    between_flush_and_rename: impl FnOnce(),
) -> Result<WriteResult, WriteError> {
    // Resolve the TARGET path without requiring it to exist yet: resolve the
    // parent directory (which must exist inside the vault) and re-attach the
    // file name.
    let (parent_rel, file_name) = split_relative(relative)?;
    let parent = if parent_rel.is_empty() {
        canonical_root.to_path_buf()
    } else {
        resolve_in_vault(canonical_root, parent_rel)?
    };
    let target = parent.join(&file_name);

    // Conflict detection against current disk state (§5.4).
    let existing = match fs::read(&target) {
        Ok(bytes) => Some(ContentHash::of(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let kind = match (existing.as_ref(), base_hash) {
        (Some(disk), Some(base)) => {
            if disk == base {
                ChangeKind::Modified
            } else {
                return Err(WriteError::Conflict {
                    disk_hash: disk.clone(),
                });
            }
        }
        (Some(_), None) => return Err(WriteError::AlreadyExists),
        // The caller thinks it is editing a note that no longer exists — that
        // is a conflict with an empty disk state, not a silent create.
        (None, Some(_)) => {
            return Err(WriteError::Conflict {
                disk_hash: ContentHash::of(b""),
            });
        }
        (None, None) => ChangeKind::Created,
    };

    // Same-directory tempfile so the rename is on one filesystem.
    let temp = parent.join(format!(".{file_name}.{}{TEMP_SUFFIX}", std::process::id()));
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?; // §5.6: fsync before rename
    }

    between_flush_and_rename();

    if let Err(error) = fs::rename(&temp, &target) {
        fs::remove_file(&temp).ok();
        return Err(error.into());
    }

    // §5.6: fsync the directory on POSIX so the rename itself is durable.
    #[cfg(unix)]
    if let Ok(dir) = fs::File::open(&parent) {
        dir.sync_all().ok();
    }

    let hash = ContentHash::of(content.as_bytes());
    sink.file_changed(FileChanged {
        relative_path: relative.to_string(),
        kind,
        origin: ChangeOrigin::App,
        hash: hash.clone(),
    });
    Ok(WriteResult {
        relative_path: relative.to_string(),
        hash,
        kind,
    })
}

fn split_relative(relative: &str) -> Result<(&str, String), WriteError> {
    let trimmed = relative.trim_matches('/');
    if trimmed.is_empty() || trimmed.ends_with('.') {
        return Err(WriteError::Path(NoteError::NotFound(PathBuf::from(
            relative,
        ))));
    }
    match trimmed.rsplit_once('/') {
        Some((parent, name)) => Ok((parent, name.to_string())),
        None => Ok(("", trimmed.to_string())),
    }
}

/// Remove stale write temp files (crash leftovers) older than `max_age`.
/// Returns the paths removed.
pub fn clean_stale_temps(dir: &Path, max_age: Duration) -> std::io::Result<Vec<PathBuf>> {
    let mut removed = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(TEMP_SUFFIX) {
            continue;
        }
        let old_enough = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age >= max_age);
        if old_enough && fs::remove_file(entry.path()).is_ok() {
            removed.push(entry.path());
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::super::note::note_read;
    use super::*;

    struct RecordingSink(Mutex<Vec<FileChanged>>);

    impl RecordingSink {
        fn new() -> Self {
            Self(Mutex::new(Vec::new()))
        }
        fn events(&self) -> Vec<FileChanged> {
            self.0.lock().expect("sink lock").clone()
        }
    }

    impl EventSink for RecordingSink {
        fn file_changed(&self, event: FileChanged) {
            self.0.lock().expect("sink lock").push(event);
        }
    }

    fn vault() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("vault");
        let root = dir.path().canonicalize().expect("canonical");
        (dir, root)
    }

    /// Create + modify happy path, with exactly one app-origin event each.
    #[test]
    fn create_then_modify_emits_one_app_event_each() {
        let (_dir, root) = vault();
        let sink = RecordingSink::new();

        let created = note_write(&root, "Note.md", "v1", None, &sink).expect("create");
        assert_eq!(created.kind, ChangeKind::Created);
        let modified =
            note_write(&root, "Note.md", "v2", Some(&created.hash), &sink).expect("modify");
        assert_eq!(modified.kind, ChangeKind::Modified);

        let events = sink.events();
        assert_eq!(events.len(), 2, "exactly one event per write");
        assert!(events.iter().all(|e| e.origin == ChangeOrigin::App));
        assert_eq!(
            note_read(&root, "Note.md")
                .expect("read")
                .content
                .as_deref(),
            Some("v2")
        );
    }

    /// T-A AC2: a stale base hash returns Conflict and leaves disk untouched.
    #[test]
    fn stale_base_hash_conflicts_and_leaves_disk_untouched() {
        let (_dir, root) = vault();
        let sink = RecordingSink::new();
        let first = note_write(&root, "Note.md", "mine", None, &sink).expect("create");

        // External edit changes the disk under us.
        std::fs::write(root.join("Note.md"), "theirs").expect("external edit");

        let result = note_write(&root, "Note.md", "mine v2", Some(&first.hash), &sink);
        match result {
            Err(WriteError::Conflict { disk_hash }) => {
                assert_eq!(disk_hash, ContentHash::of(b"theirs"));
            }
            other => panic!("expected conflict, got {other:?}"),
        }
        assert_eq!(
            std::fs::read_to_string(root.join("Note.md")).expect("read"),
            "theirs",
            "disk must be untouched after a conflict"
        );
        assert_eq!(sink.events().len(), 1, "no event for a refused write");
    }

    /// T-A AC1 (crash safety): simulate a crash in the window between the
    /// durable temp write and the rename — the target must be intact, and the
    /// leftover temp must be sweepable.
    #[test]
    fn crash_between_flush_and_rename_never_corrupts_the_target() {
        let (_dir, root) = vault();
        let sink = NullSink;
        note_write(&root, "Note.md", "stable", None, &sink).expect("create");
        let base = ContentHash::of(b"stable");

        struct SimulatedCrash;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            note_write_with_hook(&root, "Note.md", "half-written", Some(&base), &sink, || {
                std::panic::panic_any(SimulatedCrash);
            })
        }));
        assert!(result.is_err(), "the simulated crash must propagate");

        // Old content intact; no partial writes visible at the target.
        assert_eq!(
            std::fs::read_to_string(root.join("Note.md")).expect("read"),
            "stable"
        );
        // The orphan temp exists (as after a real crash) and the sweeper
        // removes it.
        let removed = clean_stale_temps(&root, Duration::ZERO).expect("sweep");
        assert_eq!(removed.len(), 1, "one orphan temp swept");
        assert!(
            removed[0].to_string_lossy().ends_with(TEMP_SUFFIX),
            "sweeps only loam temps"
        );
    }

    /// Creating over an existing file (no base hash) is refused; editing a
    /// vanished file conflicts instead of silently recreating.
    #[test]
    fn create_and_vanished_edge_cases_are_typed() {
        let (_dir, root) = vault();
        let sink = NullSink;
        let first = note_write(&root, "Note.md", "x", None, &sink).expect("create");
        assert!(matches!(
            note_write(&root, "Note.md", "y", None, &sink),
            Err(WriteError::AlreadyExists)
        ));

        std::fs::remove_file(root.join("Note.md")).expect("vanish");
        assert!(matches!(
            note_write(&root, "Note.md", "z", Some(&first.hash), &sink),
            Err(WriteError::Conflict { .. })
        ));
    }

    /// Fresh temps are not swept; only old ones are.
    #[test]
    fn stale_temp_sweep_respects_age() {
        let (_dir, root) = vault();
        std::fs::write(root.join(format!(".x.md.123{TEMP_SUFFIX}")), "orphan").expect("temp");
        std::fs::write(root.join("keep.md"), "note").expect("note");

        let removed_now = clean_stale_temps(&root, Duration::from_secs(3600)).expect("sweep young");
        assert!(removed_now.is_empty(), "young temps are kept");
        let removed_later = clean_stale_temps(&root, Duration::ZERO).expect("sweep old");
        assert_eq!(removed_later.len(), 1);
        assert!(root.join("keep.md").exists());
    }

    /// AC4: NFC/NFD unicode names and deep >260-char paths write correctly
    /// (Windows CI exercises the long-path branch of std).
    #[test]
    fn unicode_and_long_paths_write_correctly() {
        let (_dir, root) = vault();
        let sink = NullSink;

        let nfd_rel = "notes/cafe\u{301}.md"; // NFD form
        std::fs::create_dir_all(root.join("notes")).expect("parent");
        note_write(&root, nfd_rel, "bonjour", None, &sink).expect("nfd write");
        assert_eq!(
            note_read(&root, nfd_rel)
                .expect("nfd read")
                .content
                .as_deref(),
            Some("bonjour")
        );

        // Deep nested path pushing well past 260 chars total.
        let deep_parent = (0..12)
            .map(|i| format!("folder-{i:02}-abcdefghijklmnop"))
            .collect::<Vec<_>>()
            .join("/");
        std::fs::create_dir_all(root.join(&deep_parent)).expect("deep parents");
        let deep_rel = format!("{deep_parent}/note.md");
        assert!(root.join(&deep_rel).to_string_lossy().len() > 260);
        note_write(&root, &deep_rel, "deep", None, &sink).expect("deep write");
        assert_eq!(
            note_read(&root, &deep_rel)
                .expect("deep read")
                .content
                .as_deref(),
            Some("deep")
        );
    }

    /// AC5: enumeration during an in-flight write never surfaces the temp.
    #[test]
    fn temp_files_never_appear_in_enumeration() {
        let (_dir, root) = vault();
        let sink = NullSink;
        note_write(&root, "Note.md", "v1", None, &sink).expect("create");
        let base = ContentHash::of(b"v1");

        note_write_with_hook(&root, "Note.md", "v2", Some(&base), &sink, || {
            let tree = super::super::tree::enumerate(&root).expect("enumerate mid-write");
            assert!(
                tree.entries
                    .iter()
                    .all(|e| !e.logical_path.ends_with(TEMP_SUFFIX)),
                "temps must never be enumerated: {:?}",
                tree.entries
            );
            assert_eq!(tree.counts().notes, 1, "only the real note is visible");
        })
        .expect("write completes");
    }

    /// LOA-46 AC5: writes into a read-only directory fail typed and leave no
    /// temp artifacts behind.
    #[cfg(unix)]
    #[test]
    fn read_only_writes_fail_without_temp_artifacts() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, root) = vault();
        std::fs::write(root.join("Note.md"), "stable").expect("seed");
        let mut perms = std::fs::metadata(&root).expect("meta").permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(&root, perms.clone()).expect("chmod");

        let result = note_write(
            &root,
            "Note.md",
            "nope",
            Some(&ContentHash::of(b"stable")),
            &NullSink,
        );
        assert!(matches!(result, Err(WriteError::Io(_))), "typed failure");

        perms.set_mode(0o755);
        std::fs::set_permissions(&root, perms).expect("restore");
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .expect("dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(TEMP_SUFFIX))
            .collect();
        assert!(leftovers.is_empty(), "no temp artifacts: {leftovers:?}");
        assert_eq!(
            std::fs::read_to_string(root.join("Note.md")).expect("read"),
            "stable",
            "content untouched"
        );
    }

    proptest::proptest! {
        /// Property: for arbitrary content (unicode included), write→read
        /// round-trips byte-identically and the returned hash matches.
        #[test]
        fn write_read_round_trip(content in "\\PC{0,512}") {
            let (_dir, root) = vault();
            let sink = NullSink;
            let result = note_write(&root, "prop.md", &content, None, &sink).expect("write");
            let doc = note_read(&root, "prop.md").expect("read");
            proptest::prop_assert_eq!(doc.content.as_deref(), Some(content.as_str()));
            proptest::prop_assert_eq!(doc.hash, result.hash);
        }
    }
}
