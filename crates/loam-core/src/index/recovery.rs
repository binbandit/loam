//! Index recovery (D5): schema bumps, parser bumps, and corruption all
//! resolve to the same safe move — quarantine or migrate the disposable
//! cache and rebuild from files. Vault files are NEVER touched; the worst
//! diagnostic detail exposed is SQLite's own error text, never note content.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::db::{IndexDb, IndexError, read_versions};
use super::schema::SCHEMA_VERSION;
use crate::parse::PARSER_VERSION;

/// Payload for `vault://index-progress` (§5.5 interface): stable shape the
/// index pipeline emits while a rebuild fills the fresh database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub done: u64,
    pub total: u64,
}

/// Why recovery decided to discard (or rebuild) the previous index. Carries
/// versions and SQLite error text only — no paths into notes, no content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "cause")]
pub enum RecoveryCause {
    /// Older schema migrated forward in place; contents remain valid.
    SchemaMigrated { from: u32, to: u32 },
    /// The recorded parser version differs — extractions are stale.
    ParserVersionChanged { found: Option<u32>, expected: u32 },
    /// The database is from a NEWER schema than this build understands.
    FutureSchema { found: u32, supported: u32 },
    /// SQLite reported the file corrupt or unreadable.
    Corruption { detail: String },
}

/// Recovery outcome diagnostics for the shell/status UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDiagnostic {
    #[serde(flatten)]
    pub cause: RecoveryCause,
    /// Where the bad database was moved, when quarantining was possible.
    pub quarantined: Option<PathBuf>,
}

/// Result of opening with recovery.
pub enum OpenOutcome {
    /// The existing index is current and intact — reuse it.
    Ready(IndexDb),
    /// An in-place forward migration ran; contents are still valid.
    Migrated(IndexDb, RecoveryDiagnostic),
    /// A fresh, empty index. The caller must run the full rebuild pipeline
    /// (LOA-58) to repopulate it; note reads are never blocked on this.
    RebuildRequired(IndexDb, RecoveryDiagnostic),
}

impl OpenOutcome {
    pub fn db(&mut self) -> &mut IndexDb {
        match self {
            OpenOutcome::Ready(db)
            | OpenOutcome::Migrated(db, _)
            | OpenOutcome::RebuildRequired(db, _) => db,
        }
    }
}

/// Move a bad database (and WAL siblings) aside. Best-effort: if the rename
/// itself fails the file is deleted instead — the cache is disposable and a
/// clean slate beats being wedged.
fn quarantine(path: &Path) -> Option<PathBuf> {
    let target = path.with_extension("db.quarantined");
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", path.display()));
        std::fs::remove_file(side).ok();
    }
    std::fs::remove_file(&target).ok();
    match std::fs::rename(path, &target) {
        Ok(()) => Some(target),
        Err(_) => {
            std::fs::remove_file(path).ok();
            None
        }
    }
}

/// Open the index at `path`, migrating or recovering as needed. Never
/// returns a stale or corrupt index, and never touches vault files.
pub fn open_with_recovery(path: &Path) -> Result<OpenOutcome, IndexError> {
    if !path.exists() {
        let diagnostic = RecoveryDiagnostic {
            cause: RecoveryCause::ParserVersionChanged {
                found: None,
                expected: PARSER_VERSION,
            },
            quarantined: None,
        };
        return Ok(OpenOutcome::RebuildRequired(
            IndexDb::open(path)?,
            diagnostic,
        ));
    }

    let versions = match read_versions(path) {
        Ok(versions) => versions,
        Err(error) => {
            // Unreadable at the header/pragma level: corrupt. Quarantine.
            let quarantined = quarantine(path);
            let diagnostic = RecoveryDiagnostic {
                cause: RecoveryCause::Corruption {
                    detail: error.to_string(),
                },
                quarantined,
            };
            return Ok(OpenOutcome::RebuildRequired(
                IndexDb::open(path)?,
                diagnostic,
            ));
        }
    };

    if versions.schema > SCHEMA_VERSION {
        let quarantined = quarantine(path);
        let diagnostic = RecoveryDiagnostic {
            cause: RecoveryCause::FutureSchema {
                found: versions.schema,
                supported: SCHEMA_VERSION,
            },
            quarantined,
        };
        return Ok(OpenOutcome::RebuildRequired(
            IndexDb::open(path)?,
            diagnostic,
        ));
    }

    if versions.schema > 0 && versions.parser != Some(PARSER_VERSION) {
        let quarantined = quarantine(path);
        let diagnostic = RecoveryDiagnostic {
            cause: RecoveryCause::ParserVersionChanged {
                found: versions.parser,
                expected: PARSER_VERSION,
            },
            quarantined,
        };
        return Ok(OpenOutcome::RebuildRequired(
            IndexDb::open(path)?,
            diagnostic,
        ));
    }

    let from = versions.schema;
    let db = match IndexDb::open(path) {
        Ok(db) => db,
        Err(_) => {
            let quarantined = quarantine(path);
            let diagnostic = RecoveryDiagnostic {
                cause: RecoveryCause::Corruption {
                    detail: "database failed to open or migrate".into(),
                },
                quarantined,
            };
            return Ok(OpenOutcome::RebuildRequired(
                IndexDb::open(path)?,
                diagnostic,
            ));
        }
    };

    if let Err(error) = db.check_integrity() {
        drop(db);
        let quarantined = quarantine(path);
        let diagnostic = RecoveryDiagnostic {
            cause: RecoveryCause::Corruption {
                detail: error.to_string(),
            },
            quarantined,
        };
        return Ok(OpenOutcome::RebuildRequired(
            IndexDb::open(path)?,
            diagnostic,
        ));
    }

    if from < SCHEMA_VERSION && from > 0 {
        let diagnostic = RecoveryDiagnostic {
            cause: RecoveryCause::SchemaMigrated {
                from,
                to: SCHEMA_VERSION,
            },
            quarantined: None,
        };
        return Ok(OpenOutcome::Migrated(db, diagnostic));
    }
    if from == 0 {
        let diagnostic = RecoveryDiagnostic {
            cause: RecoveryCause::ParserVersionChanged {
                found: None,
                expected: PARSER_VERSION,
            },
            quarantined: None,
        };
        return Ok(OpenOutcome::RebuildRequired(db, diagnostic));
    }
    Ok(OpenOutcome::Ready(db))
}

/// A rebuild running beside the live index: writes land in `<path>.rebuild`
/// and replace the real database only on [`RebuildSession::commit`] — an
/// interrupted rebuild leaves the last valid index untouched, and a stale
/// temp file is cleared on the next `begin` (the clean restart path, AC4).
pub struct RebuildSession {
    final_path: PathBuf,
    temp_path: PathBuf,
    db: Option<IndexDb>,
    pre_commit_hook: Option<CommitHook>,
}

/// Fault-injection hook run just before the atomic replace.
type CommitHook = Box<dyn FnMut() -> std::io::Result<()> + Send>;

impl RebuildSession {
    pub fn begin(final_path: &Path) -> Result<Self, IndexError> {
        let temp_path = PathBuf::from(format!("{}.rebuild", final_path.display()));
        for suffix in ["", "-wal", "-shm"] {
            std::fs::remove_file(format!("{}{suffix}", temp_path.display())).ok();
        }
        let db = IndexDb::open(&temp_path)?;
        Ok(Self {
            final_path: final_path.to_path_buf(),
            temp_path,
            db: Some(db),
            pre_commit_hook: None,
        })
    }

    /// The database rebuild writes populate.
    pub fn db(&mut self) -> &mut IndexDb {
        self.db.as_mut().expect("session not yet committed")
    }

    /// Fault-injection seam (tests): runs after the temp database closes,
    /// immediately before the atomic rename.
    pub fn with_pre_commit_hook(
        mut self,
        hook: impl FnMut() -> std::io::Result<()> + Send + 'static,
    ) -> Self {
        self.pre_commit_hook = Some(Box::new(hook));
        self
    }

    /// Validate, close, and atomically move the rebuilt database over the
    /// live one. On any failure the live index is untouched.
    pub fn commit(mut self) -> Result<IndexDb, IndexError> {
        let db = self.db.take().expect("session not yet committed");
        db.check_integrity()?;
        drop(db); // close, flushing WAL into the main file

        if let Some(hook) = self.pre_commit_hook.as_mut() {
            hook()?;
        }
        for suffix in ["-wal", "-shm"] {
            std::fs::remove_file(format!("{}{suffix}", self.final_path.display())).ok();
        }
        std::fs::rename(&self.temp_path, &self.final_path)?;
        IndexDb::open(&self.final_path)
    }
}

/// `migrations()` chain sanity: valid and ending exactly at SCHEMA_VERSION.
#[cfg(test)]
mod tests {
    use super::super::db::migrations;
    use super::*;

    #[test]
    fn migration_chain_is_valid_and_current() {
        migrations().validate().expect("chain valid");
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("index.db");
        drop(IndexDb::open(&path).expect("open"));
        let versions = read_versions(&path).expect("versions");
        assert_eq!(versions.schema, SCHEMA_VERSION);
    }
}
