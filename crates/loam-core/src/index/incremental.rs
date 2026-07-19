//! Transactional incremental reindexing (D5, LOA-59): normalized E02
//! `VaultEvent`s are applied one at a time on the single writer — each
//! create/modify replaces that file's complete record set in one
//! transaction (LOA-55's `replace_file`), renames preserve row identity,
//! deletes cascade, and unchanged content hashes are deduplicated into
//! no-ops. Every application returns a stable, serializable outcome.

use std::path::PathBuf;

use serde::Serialize;
use time::OffsetDateTime;

use super::db::{IndexDb, IndexError};
use super::pipeline::{FileIssue, index_file};
use crate::vault::{EventKind, VaultEvent, is_builtin_ignored, is_ignorable_path};

/// Stable completion/error result for one applied event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "result")]
pub enum ReindexOutcome {
    /// Create/modify indexed a fresh record set for the path.
    Indexed { path: String },
    /// Rename updated the stored path; dependent rows kept their identity.
    Renamed { from: String, to: String },
    /// Delete removed the file and all dependents.
    Removed { path: String },
    /// Content hash unchanged — deduplicated to a no-op.
    Unchanged { path: String },
    /// Not an indexable Markdown path (ignored dirs, tempfiles, non-`.md`).
    Ineligible { path: String },
    /// The file could not be read or indexed; the index is unchanged.
    Failed { issue: FileIssue },
}

/// The incremental reindexer. Owns the single-writer [`IndexDb`] — the type
/// is `Send` but not `Sync`, so the owning writer thread is the queue: hand
/// it normalized events in arrival order and forward each outcome.
pub struct Reindexer {
    db: IndexDb,
    canonical_root: PathBuf,
}

fn indexable(path: &str) -> bool {
    path.to_lowercase().ends_with(".md") && !is_ignorable_path(path) && !is_builtin_ignored(path)
}

impl Reindexer {
    pub fn new(db: IndexDb, canonical_root: impl Into<PathBuf>) -> Self {
        Self {
            db,
            canonical_root: canonical_root.into(),
        }
    }

    pub fn into_db(self) -> IndexDb {
        self.db
    }

    pub fn db_mut(&mut self) -> &mut IndexDb {
        &mut self.db
    }

    /// Apply one normalized watcher event. Infallible short of a database
    /// error: per-file problems come back as `ReindexOutcome::Failed`.
    pub fn apply(&mut self, event: &VaultEvent) -> Result<ReindexOutcome, IndexError> {
        match &event.kind {
            EventKind::Created | EventKind::Modified => self.upsert(&event.path),
            EventKind::Renamed { from } => self.rename(from, &event.path),
            EventKind::Deleted => {
                if !indexable(&event.path) {
                    return Ok(ReindexOutcome::Ineligible {
                        path: event.path.clone(),
                    });
                }
                self.db.remove_file(&event.path)?;
                Ok(ReindexOutcome::Removed {
                    path: event.path.clone(),
                })
            }
        }
    }

    fn upsert(&mut self, path: &str) -> Result<ReindexOutcome, IndexError> {
        if !indexable(path) {
            return Ok(ReindexOutcome::Ineligible {
                path: path.to_string(),
            });
        }
        // Dedup before parsing: hash the bytes and compare with the stored
        // record — repeated identical events (sync-tool churn) are no-ops.
        let stored = self.db.stored_hash(path)?;
        if let Some(stored) = stored {
            let on_disk = crate::vault::note_read(&self.canonical_root, path)
                .ok()
                .map(|note| note.hash.as_str().to_string());
            if on_disk.as_deref() == Some(stored.as_str()) {
                return Ok(ReindexOutcome::Unchanged {
                    path: path.to_string(),
                });
            }
        }
        let indexed_ms = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
        match index_file(&mut self.db, &self.canonical_root, path, indexed_ms) {
            Ok(()) => Ok(ReindexOutcome::Indexed {
                path: path.to_string(),
            }),
            Err(issue) => Ok(ReindexOutcome::Failed { issue }),
        }
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<ReindexOutcome, IndexError> {
        let from_indexable = indexable(from);
        let to_indexable = indexable(to);
        match (from_indexable, to_indexable) {
            // Markdown → markdown: move the row, dependents keep identity.
            (true, true) => {
                if self.db.rename_file(from, to)? {
                    Ok(ReindexOutcome::Renamed {
                        from: from.to_string(),
                        to: to.to_string(),
                    })
                } else {
                    // Unknown source (e.g. events raced a rebuild): index the
                    // destination fresh instead of dropping the change.
                    self.upsert(to)
                }
            }
            // Renamed INTO scope: it is effectively a create.
            (false, true) => self.upsert(to),
            // Renamed OUT of scope (e.g. `.md` → `.txt`): remove.
            (true, false) => {
                self.db.remove_file(from)?;
                Ok(ReindexOutcome::Removed {
                    path: from.to_string(),
                })
            }
            (false, false) => Ok(ReindexOutcome::Ineligible {
                path: to.to_string(),
            }),
        }
    }
}
