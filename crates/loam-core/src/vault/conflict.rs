//! External-change conflict decisions (§5.6): when the disk changes under an
//! open note, a clean buffer reloads silently (cursor metadata preserved by
//! the caller) and a dirty buffer surfaces a non-blocking conflict carrying
//! mine/disk/base payloads. **Nothing on this path ever discards content, and
//! no resolution happens without an explicit command.**

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

use super::note::ContentHash;

/// One open note buffer, tracked from the moment it is read.
#[derive(Debug, Clone)]
struct Session {
    /// Content at last read/write — the common base for 3-way merge.
    base_content: String,
    base_hash: ContentHash,
    /// The user's unsaved edits, if any. Preserved until explicit resolution.
    dirty_content: Option<String>,
    /// An unresolved conflict, if one has been raised.
    conflict: Option<ConflictPayload>,
}

/// §5.6 merge payload: "Keep mine / Take disk / Merge manually".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPayload {
    pub path: String,
    /// The user's unsaved buffer.
    pub mine: String,
    /// Current on-disk content.
    pub disk: String,
    /// Common base (content at last read/write) for 3-way merge.
    pub base: String,
    pub disk_hash: ContentHash,
}

/// What the UI should do about an external change (§5.6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case", tag = "decision")]
pub enum ChangeDecision {
    /// Buffer clean: reload silently, preserving cursor (caller keeps cursor
    /// metadata; the core never touches it).
    Reload,
    /// Buffer dirty: `vault://conflict{path}` — payload retrievable until an
    /// explicit resolution.
    Conflict,
    /// The change matches what the session already has (duplicate event or
    /// self-echo): nothing to do.
    NoOp,
}

/// The user's explicit resolution command (§5.6 banner actions).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    KeepMine,
    TakeDisk,
    /// Manual merge result composed in the UI.
    Merged(String),
}

/// What the caller must write back (via the LOA-28 writer) after a resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolutionOutcome {
    /// Content the buffer should now hold.
    pub buffer: String,
    /// If `Some`, the caller persists this content with the returned base
    /// hash via `note_write` (conflict-safe against further races).
    pub write: Option<(String, ContentHash)>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConflictError {
    #[error("no open session for {0}")]
    NoSession(String),
    #[error("no unresolved conflict for {0}")]
    NoConflict(String),
}

/// Tracks open-note sessions and their conflict state.
#[derive(Default)]
pub struct SessionTracker {
    sessions: Mutex<HashMap<String, Session>>,
}

impl SessionTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register (or refresh) a session after a read or successful write.
    pub fn opened(&self, path: &str, content: &str) {
        let mut sessions = self.sessions.lock().expect("sessions lock");
        sessions.insert(
            path.to_string(),
            Session {
                base_content: content.to_string(),
                base_hash: ContentHash::of(content.as_bytes()),
                dirty_content: None,
                conflict: None,
            },
        );
    }

    /// The editor reports unsaved edits. Kept until explicit resolution.
    pub fn buffer_changed(&self, path: &str, dirty: &str) -> Result<(), ConflictError> {
        let mut sessions = self.sessions.lock().expect("sessions lock");
        let session = sessions
            .get_mut(path)
            .ok_or_else(|| ConflictError::NoSession(path.to_string()))?;
        session.dirty_content = Some(dirty.to_string());
        Ok(())
    }

    pub fn closed(&self, path: &str) {
        self.sessions.lock().expect("sessions lock").remove(path);
    }

    /// An external change arrived (from the LOA-38 watcher) with the new disk
    /// content. Decides reload vs conflict; idempotent for duplicate events.
    pub fn external_change(
        &self,
        path: &str,
        disk_content: &str,
    ) -> Result<ChangeDecision, ConflictError> {
        let mut sessions = self.sessions.lock().expect("sessions lock");
        let session = sessions
            .get_mut(path)
            .ok_or_else(|| ConflictError::NoSession(path.to_string()))?;
        let disk_hash = ContentHash::of(disk_content.as_bytes());

        // Duplicate/no-op: disk equals what we already consider base and no
        // conflict is pending on different content.
        if disk_hash == session.base_hash && session.conflict.is_none() {
            return Ok(ChangeDecision::NoOp);
        }
        // Repeated identical watcher events while a conflict is pending must
        // not raise a second conflict (AC3).
        if let Some(existing) = &session.conflict
            && existing.disk_hash == disk_hash
        {
            return Ok(ChangeDecision::NoOp);
        }

        match &session.dirty_content {
            None => {
                // Clean buffer: silent reload; the new disk state becomes base.
                session.base_content = disk_content.to_string();
                session.base_hash = disk_hash;
                session.conflict = None;
                Ok(ChangeDecision::Reload)
            }
            Some(dirty) => {
                // Dirty buffer: raise (or update) the conflict, preserving
                // every version. No content is discarded here.
                session.conflict = Some(ConflictPayload {
                    path: path.to_string(),
                    mine: dirty.clone(),
                    disk: disk_content.to_string(),
                    base: session.base_content.clone(),
                    disk_hash,
                });
                Ok(ChangeDecision::Conflict)
            }
        }
    }

    /// Retrieve the pending merge payload for the banner/diff UI.
    pub fn conflict_payload(&self, path: &str) -> Option<ConflictPayload> {
        self.sessions
            .lock()
            .expect("sessions lock")
            .get(path)
            .and_then(|s| s.conflict.clone())
    }

    /// Apply an explicit resolution command. This is the ONLY way a conflict
    /// is cleared; until it is called, both versions stay retrievable.
    pub fn resolve(
        &self,
        path: &str,
        resolution: Resolution,
    ) -> Result<ResolutionOutcome, ConflictError> {
        let mut sessions = self.sessions.lock().expect("sessions lock");
        let session = sessions
            .get_mut(path)
            .ok_or_else(|| ConflictError::NoSession(path.to_string()))?;
        let conflict = session
            .conflict
            .take()
            .ok_or_else(|| ConflictError::NoConflict(path.to_string()))?;

        let outcome = match resolution {
            Resolution::KeepMine => {
                // Buffer wins; persist it over the disk state (conflict-safe
                // against yet another race via the disk hash).
                session.base_content = conflict.mine.clone();
                session.base_hash = ContentHash::of(conflict.mine.as_bytes());
                session.dirty_content = None;
                ResolutionOutcome {
                    buffer: conflict.mine.clone(),
                    write: Some((conflict.mine, conflict.disk_hash)),
                }
            }
            Resolution::TakeDisk => {
                // Disk wins; the dirty buffer is replaced ONLY because the
                // user explicitly said so.
                session.base_content = conflict.disk.clone();
                session.base_hash = conflict.disk_hash.clone();
                session.dirty_content = None;
                ResolutionOutcome {
                    buffer: conflict.disk,
                    write: None,
                }
            }
            Resolution::Merged(merged) => {
                session.base_content = merged.clone();
                session.base_hash = ContentHash::of(merged.as_bytes());
                session.dirty_content = None;
                ResolutionOutcome {
                    buffer: merged.clone(),
                    write: Some((merged, conflict.disk_hash)),
                }
            }
        };
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AC1: clean buffer → Reload; the core never touches cursor metadata
    /// (nothing here could — reload is a decision, not a mutation of UI state).
    #[test]
    fn clean_external_edit_requests_reload() {
        let tracker = SessionTracker::new();
        tracker.opened("Note.md", "v1");
        let decision = tracker
            .external_change("Note.md", "external v2")
            .expect("decision");
        assert_eq!(decision, ChangeDecision::Reload);
        // The new disk state is the base now; the same event again is a no-op.
        assert_eq!(
            tracker
                .external_change("Note.md", "external v2")
                .expect("again"),
            ChangeDecision::NoOp
        );
    }

    /// AC2: dirty buffer → Conflict with all three payloads preserved.
    #[test]
    fn dirty_external_edit_conflicts_and_preserves_both_versions() {
        let tracker = SessionTracker::new();
        tracker.opened("Note.md", "base");
        tracker
            .buffer_changed("Note.md", "mine (unsaved)")
            .expect("dirty");

        let decision = tracker
            .external_change("Note.md", "theirs (disk)")
            .expect("decision");
        assert_eq!(decision, ChangeDecision::Conflict);

        let payload = tracker.conflict_payload("Note.md").expect("payload");
        assert_eq!(payload.mine, "mine (unsaved)");
        assert_eq!(payload.disk, "theirs (disk)");
        assert_eq!(payload.base, "base");
        assert_eq!(payload.disk_hash, ContentHash::of(b"theirs (disk)"));
    }

    /// AC3: repeated identical watcher events raise exactly one conflict.
    #[test]
    fn duplicate_events_do_not_duplicate_conflicts() {
        let tracker = SessionTracker::new();
        tracker.opened("Note.md", "base");
        tracker.buffer_changed("Note.md", "mine").expect("dirty");

        assert_eq!(
            tracker.external_change("Note.md", "theirs").expect("first"),
            ChangeDecision::Conflict
        );
        for _ in 0..3 {
            assert_eq!(
                tracker.external_change("Note.md", "theirs").expect("dup"),
                ChangeDecision::NoOp
            );
        }
        // A *different* external change updates the single pending conflict.
        assert_eq!(
            tracker
                .external_change("Note.md", "theirs v2")
                .expect("newer"),
            ChangeDecision::Conflict
        );
        assert_eq!(
            tracker.conflict_payload("Note.md").expect("payload").disk,
            "theirs v2"
        );
    }

    /// AC4: nothing resolves without an explicit command; every payload stays
    /// retrievable indefinitely, and resolution outcomes are exact.
    #[test]
    fn resolution_only_happens_on_explicit_command() {
        let tracker = SessionTracker::new();
        tracker.opened("Note.md", "base");
        tracker.buffer_changed("Note.md", "mine").expect("dirty");
        tracker
            .external_change("Note.md", "theirs")
            .expect("conflict");

        // Time passes; more reads of the payload — still unresolved.
        for _ in 0..2 {
            assert!(tracker.conflict_payload("Note.md").is_some());
        }

        // Keep mine: buffer stays mine, and a conflict-safe write is ordered.
        let outcome = tracker
            .resolve("Note.md", Resolution::KeepMine)
            .expect("resolve");
        assert_eq!(outcome.buffer, "mine");
        let (content, base) = outcome.write.expect("write ordered");
        assert_eq!(content, "mine");
        assert_eq!(base, ContentHash::of(b"theirs"));
        assert!(tracker.conflict_payload("Note.md").is_none(), "cleared");
        assert!(matches!(
            tracker.resolve("Note.md", Resolution::KeepMine),
            Err(ConflictError::NoConflict(_))
        ));

        // Take disk requires no write; merged writes the merged content.
        tracker.buffer_changed("Note.md", "mine 2").expect("dirty");
        tracker
            .external_change("Note.md", "theirs 2")
            .expect("conflict");
        let outcome = tracker
            .resolve("Note.md", Resolution::TakeDisk)
            .expect("resolve");
        assert_eq!(outcome.buffer, "theirs 2");
        assert!(outcome.write.is_none());

        tracker.buffer_changed("Note.md", "mine 3").expect("dirty");
        tracker
            .external_change("Note.md", "theirs 3")
            .expect("conflict");
        let outcome = tracker
            .resolve("Note.md", Resolution::Merged("merged".into()))
            .expect("resolve");
        assert_eq!(outcome.buffer, "merged");
        assert_eq!(
            outcome.write.expect("write").1,
            ContentHash::of(b"theirs 3"),
            "merged write is conflict-safe against the disk it merged"
        );
    }

    #[test]
    fn unknown_sessions_are_typed_errors() {
        let tracker = SessionTracker::new();
        assert!(matches!(
            tracker.external_change("Ghost.md", "x"),
            Err(ConflictError::NoSession(_))
        ));
        assert!(matches!(
            tracker.buffer_changed("Ghost.md", "x"),
            Err(ConflictError::NoSession(_))
        ));
    }
}
