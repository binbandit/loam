//! The deterministic full-index pipeline (D5, LOA-58): enumerate (E02) →
//! read (E02) → parse (E03) → index, streamed file-by-file on the single
//! writer thread into a [`RebuildSession`], and committed as one validated
//! snapshot. The live index and the vault stay untouched until the atomic
//! replace, so note reads never block on a rebuild.

use std::path::Path;

use time::OffsetDateTime;

use super::db::{FileRecord, IndexDb, IndexError};
use super::recovery::{IndexProgress, RebuildSession};
use crate::parse::{ExtractedDoc, parse};
use crate::vault::{EntryKind, NoteError, SizePolicy, TreeError, enumerate, note_read};

/// A file the pipeline could not index. `detail` carries the error KIND —
/// never file content.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIssue {
    pub path: String,
    pub detail: String,
}

/// Outcome of a completed full rebuild.
pub struct RebuildReport {
    pub db: IndexDb,
    pub indexed: u64,
    pub total: u64,
    /// Files skipped with diagnostics; unrelated files still indexed (AC3).
    pub issues: Vec<FileIssue>,
}

#[derive(Debug, thiserror::Error)]
pub enum RebuildError {
    #[error("failed to enumerate the vault: {0}")]
    Tree(#[from] TreeError),
    #[error(transparent)]
    Index(#[from] IndexError),
    #[error("rebuild cancelled")]
    Cancelled,
}

fn policy_str(policy: SizePolicy) -> &'static str {
    match policy {
        SizePolicy::Normal => "full",
        SizePolicy::SourceOnly => "source-only",
        SizePolicy::MetadataOnly => "metadata-only",
    }
}

/// Index one Markdown file into `db`. Shared by the full pipeline and the
/// incremental reindexer (LOA-59). Metadata-only files (>20 MB) keep their
/// file record — metadata is retained while body-derived rows are skipped.
pub(super) fn index_file(
    db: &mut IndexDb,
    canonical_root: &Path,
    logical_path: &str,
    indexed_ms: i64,
) -> Result<(), FileIssue> {
    let note = note_read(canonical_root, logical_path).map_err(|error| FileIssue {
        path: logical_path.to_string(),
        detail: issue_detail(&error),
    })?;
    let doc = match &note.content {
        Some(content) => parse(content),
        None => ExtractedDoc::default(),
    };
    let record = FileRecord {
        path: logical_path,
        content_hash: note.hash.as_str(),
        size: note.meta.size,
        modified_ms: note.meta.modified_ms.map(|m| m as i64).unwrap_or(0),
        indexed_ms,
        size_policy: policy_str(note.meta.size_policy),
    };
    db.replace_file(&record, &doc).map_err(|error| FileIssue {
        path: logical_path.to_string(),
        detail: format!("index write failed: {error}"),
    })
}

/// Error KIND only — paths within the vault are fine, content never appears.
fn issue_detail(error: &NoteError) -> String {
    match error {
        NoteError::NotUtf8(_) => "not valid UTF-8".to_string(),
        NoteError::MaterializationRequired(_) => "cloud placeholder not materialized".to_string(),
        NoteError::NotFound(_) => "file disappeared during indexing".to_string(),
        other => format!("read failed: {other}"),
    }
}

/// Rebuild the whole index for `canonical_root` into `index_path`.
///
/// Deterministic: files stream in NFC logical-path order, so identical vault
/// content yields identical logical rows. `progress` receives a monotonic
/// `{done, total}` sequence ending at `total`; `should_cancel` is polled
/// between files and aborts WITHOUT touching the live index (the temp
/// database is discarded; the next rebuild starts clean).
pub fn rebuild_full(
    canonical_root: &Path,
    index_path: &Path,
    progress: &mut dyn FnMut(IndexProgress),
    should_cancel: &dyn Fn() -> bool,
) -> Result<RebuildReport, RebuildError> {
    let tree = enumerate(canonical_root)?;
    let markdown: Vec<&str> = tree
        .entries
        .iter()
        .filter(|e| e.kind == EntryKind::Markdown)
        .map(|e| e.logical_path.as_str())
        .collect();

    let total = markdown.len() as u64;
    let indexed_ms = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
    let mut session = RebuildSession::begin(index_path)?;
    let mut issues = Vec::new();
    let mut done: u64 = 0;

    progress(IndexProgress { done, total });
    for logical_path in markdown {
        if should_cancel() {
            return Err(RebuildError::Cancelled);
        }
        if let Err(issue) = index_file(session.db(), canonical_root, logical_path, indexed_ms) {
            issues.push(issue);
        }
        done += 1;
        progress(IndexProgress { done, total });
    }

    let db = session.commit()?;
    Ok(RebuildReport {
        db,
        indexed: done - issues.len() as u64,
        total,
        issues,
    })
}
