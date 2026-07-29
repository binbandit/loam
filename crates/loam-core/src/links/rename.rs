//! Rename as refactor (LOA-106/LOA-109, §3.4).
//!
//! Renaming a note rewrites every inbound link in the vault. That is a
//! destructive, vault-wide operation, so it is split in two: planning reads
//! and decides, applying writes. The plan is immutable and carries the hash
//! every affected file had when it was read — applying re-checks those
//! hashes and refuses to write over anything that moved in between.
//!
//! Each file is written through the atomic writer, one at a time, and the
//! target note is moved at a defined point in the sequence. A cancellation
//! stops between files and reports exactly what had already been done: a
//! partial rename is always explicit, never silent.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::links::resolve::{MatchKind, Resolution, VaultEntry, resolve_target};
use crate::parse::{LinkStyle, SourceRange};
use crate::vault::{self, ContentHash, EventSink};

/// How a rewritten link should be spelled (§3.4 new-link format setting).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkFormat {
    /// Just the filename while it stays unique in the vault (default).
    #[default]
    ShortestUnique,
    /// Path relative to the linking note.
    Relative,
    /// Full vault-relative path.
    AbsoluteInVault,
}

/// One link occurrence a rename would rewrite.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkEdit {
    /// Byte range of the *target text*, not the whole link.
    pub range: SourceRange,
    pub before: String,
    pub after: String,
}

/// Every rewrite inside one source note, plus the hash it was read at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePlan {
    pub path: String,
    /// Hash when planned; apply refuses if the file has moved on (§5.4).
    pub base_hash: String,
    pub edits: Vec<LinkEdit>,
    /// Line-level before/after for the preview list (LOA-111).
    pub previews: Vec<PreviewLine>,
}

/// One line as it reads now and as it would read after the rename.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLine {
    /// 1-based line number in the source note.
    pub line: u32,
    pub before: String,
    pub after: String,
}

/// Why a rename cannot proceed as asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PlanProblem {
    /// A note already lives at the destination path.
    #[serde(rename_all = "camelCase")]
    Collision { path: String },
    /// A source note changed between indexing and planning.
    #[serde(rename_all = "camelCase")]
    StaleSource { path: String },
}

/// An immutable description of a rename and everything it would touch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePlan {
    pub from: String,
    pub to: String,
    pub files: Vec<FilePlan>,
    pub problems: Vec<PlanProblem>,
    /// Total link occurrences across every file.
    pub link_count: u32,
}

impl RenamePlan {
    pub fn file_count(&self) -> u32 {
        self.files.len() as u32
    }

    /// §3.4: more than 20 affected files requires an explicit confirmation.
    pub fn needs_confirmation(&self) -> bool {
        self.file_count() > 20
    }

    pub fn is_blocked(&self) -> bool {
        !self.problems.is_empty()
    }
}

/// A link occurrence as the index knows it, enough to rewrite in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundLink {
    /// Source note containing the link.
    pub source_path: String,
    /// Target text exactly as written.
    pub target: String,
    /// Byte range of the target text inside the source note.
    pub range: SourceRange,
    pub style: LinkStyle,
}

/// Spells the new target for one link, in the requested format.
fn rewrite_target(
    old_target: &str,
    new_path: &str,
    source_path: &str,
    format: LinkFormat,
    vault: &[VaultEntry],
) -> String {
    let parsed = super::resolve::parse_target(old_target);
    let fragment = match (&parsed.heading, &parsed.block) {
        (Some(heading), _) => format!("#{heading}"),
        (_, Some(block)) => format!("#^{block}"),
        _ => String::new(),
    };
    // A link that named the note by an alias keeps naming it that way: the
    // alias still points at the note after the move, so rewriting it would
    // be churn, not a fix.
    if matches!(
        resolve_target(old_target, source_path, vault),
        Resolution::Resolved {
            kind: MatchKind::Alias,
            ..
        }
    ) {
        return old_target.to_string();
    }

    let kept_extension = parsed.note.to_lowercase().ends_with(".md");
    let stem = new_path.strip_suffix(".md").unwrap_or(new_path);
    let base = match format {
        LinkFormat::AbsoluteInVault => stem.to_string(),
        LinkFormat::Relative => relative_path(source_path, stem),
        LinkFormat::ShortestUnique => {
            let name = stem.rsplit('/').next().unwrap_or(stem);
            let unique = vault
                .iter()
                .filter(|entry| {
                    let other = entry.path.strip_suffix(".md").unwrap_or(&entry.path);
                    other.rsplit('/').next().unwrap_or(other).to_lowercase() == name.to_lowercase()
                })
                .count()
                <= 1;
            if unique {
                name.to_string()
            } else {
                stem.to_string()
            }
        }
    };
    let base = if kept_extension {
        format!("{base}.md")
    } else {
        base
    };
    format!("{base}{fragment}")
}

/// `Projects/Loam.md` seen from `Daily/Today.md` → `../Projects/Loam`.
fn relative_path(source_path: &str, target_stem: &str) -> String {
    let source_dirs: Vec<&str> = source_path.split('/').collect();
    let source_dirs = &source_dirs[..source_dirs.len().saturating_sub(1)];
    let target_parts: Vec<&str> = target_stem.split('/').collect();

    let shared = source_dirs
        .iter()
        .zip(target_parts.iter())
        .take_while(|(a, b)| a.to_lowercase() == b.to_lowercase())
        .count();
    let ups = source_dirs.len() - shared;
    let mut out = String::new();
    for _ in 0..ups {
        out.push_str("../");
    }
    out.push_str(&target_parts[shared..].join("/"));
    if out.is_empty() {
        target_parts.last().unwrap_or(&target_stem).to_string()
    } else {
        out
    }
}

/// Reads a note and returns its content plus current hash.
fn read_source(root: &Path, path: &str) -> Option<(String, ContentHash)> {
    let doc = vault::note_read(root, path).ok()?;
    let content = doc.content?;
    Some((content, doc.hash))
}

/// Builds the immutable plan: what would change, and what stands in the way.
///
/// `inbound` comes from the index (every link whose target names `from`);
/// `vault` is the note list resolution runs against.
pub fn plan_rename(
    root: &Path,
    from: &str,
    to: &str,
    inbound: &[InboundLink],
    vault: &[VaultEntry],
    format: LinkFormat,
) -> RenamePlan {
    let mut problems = Vec::new();

    // A note already at the destination is a hard stop: renaming onto it
    // would destroy a file.
    if vault
        .iter()
        .any(|entry| entry.path.to_lowercase() == to.to_lowercase() && entry.path != from)
    {
        problems.push(PlanProblem::Collision {
            path: to.to_string(),
        });
    }

    // Group by source note, preserving index order within each file.
    let mut files: Vec<FilePlan> = Vec::new();
    for link in inbound {
        let Some((content, hash)) = read_source(root, &link.source_path) else {
            problems.push(PlanProblem::StaleSource {
                path: link.source_path.clone(),
            });
            continue;
        };

        let start = link.range.start;
        let end = link.range.end;
        if end > content.len() || content.get(start..end) != Some(link.target.as_str()) {
            // The index is behind the file. Say so rather than rewriting a
            // range that no longer means what it did.
            problems.push(PlanProblem::StaleSource {
                path: link.source_path.clone(),
            });
            continue;
        }

        let after = rewrite_target(&link.target, to, &link.source_path, format, vault);
        if after == link.target {
            continue;
        }

        let edit = LinkEdit {
            range: link.range,
            before: link.target.clone(),
            after: after.clone(),
        };
        let preview = preview_line(&content, start, end, &after);

        match files.iter_mut().find(|f| f.path == link.source_path) {
            Some(file) => {
                file.edits.push(edit);
                file.previews.push(preview);
            }
            None => files.push(FilePlan {
                path: link.source_path.clone(),
                base_hash: hash.as_str().to_string(),
                edits: vec![edit],
                previews: vec![preview],
            }),
        }
    }

    // Deterministic order so a preview list reads the same every time.
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let link_count = files.iter().map(|file| file.edits.len() as u32).sum();

    RenamePlan {
        from: from.to_string(),
        to: to.to_string(),
        files,
        problems,
        link_count,
    }
}

/// The affected line, before and after, for the preview list.
fn preview_line(content: &str, start: usize, end: usize, after: &str) -> PreviewLine {
    let line_start = content[..start].rfind('\n').map_or(0, |index| index + 1);
    let line_end = content[end..]
        .find('\n')
        .map_or(content.len(), |index| end + index);
    let before = &content[line_start..line_end];
    let line = content[..line_start].matches('\n').count() as u32 + 1;
    let mut rewritten = String::with_capacity(before.len());
    rewritten.push_str(&content[line_start..start]);
    rewritten.push_str(after);
    rewritten.push_str(&content[end..line_end]);
    PreviewLine {
        line,
        before: before.to_string(),
        after: rewritten,
    }
}

/// What actually happened when a plan was applied.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameReport {
    pub changed_files: Vec<String>,
    pub changed_links: u32,
    /// Files skipped because they changed since planning.
    pub skipped: Vec<String>,
    /// Files whose write failed, with the reason.
    pub failed: Vec<FailedFile>,
    /// Files not attempted because the caller cancelled.
    pub remaining: Vec<String>,
    /// Whether the note itself was moved.
    pub renamed: bool,
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedFile {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyError {
    #[error("the plan is blocked: {0:?}")]
    Blocked(Vec<PlanProblem>),
    #[error("failed to move the note: {0}")]
    Rename(#[from] vault::OpsError),
}

/// Applies a plan: rewrite every inbound link, then move the note.
///
/// The move happens **last**, so a cancellation or failure leaves the vault
/// in a state where the note is still where every link expects it.
/// `should_cancel` is consulted between files.
pub fn apply_rename(
    root: &Path,
    plan: &RenamePlan,
    sink: &dyn EventSink,
    should_cancel: &dyn Fn() -> bool,
) -> Result<RenameReport, ApplyError> {
    if plan.is_blocked() {
        return Err(ApplyError::Blocked(plan.problems.clone()));
    }
    let mut report = RenameReport::default();

    for (index, file) in plan.files.iter().enumerate() {
        if should_cancel() {
            report.cancelled = true;
            report.remaining = plan.files[index..]
                .iter()
                .map(|remaining| remaining.path.clone())
                .collect();
            return Ok(report);
        }

        let Some((content, hash)) = read_source(root, &file.path) else {
            report.skipped.push(file.path.clone());
            continue;
        };
        if hash.as_str() != file.base_hash {
            // Planned against an older version: refuse rather than clobber.
            report.skipped.push(file.path.clone());
            continue;
        }

        let rewritten = apply_edits(&content, &file.edits);
        match vault::note_write(root, &file.path, &rewritten, Some(&hash), sink) {
            Ok(_) => {
                report.changed_files.push(file.path.clone());
                report.changed_links += file.edits.len() as u32;
            }
            Err(error) => report.failed.push(FailedFile {
                path: file.path.clone(),
                reason: error.to_string(),
            }),
        }
    }

    // Transaction point: links now name the destination, so the note moves.
    if plan.from != plan.to {
        vault::rename(root, &plan.from, &plan.to)?;
        report.renamed = true;
    }
    Ok(report)
}

/// Applies edits back-to-front so earlier ranges stay valid.
fn apply_edits(content: &str, edits: &[LinkEdit]) -> String {
    let mut ordered: Vec<&LinkEdit> = edits.iter().collect();
    ordered.sort_by_key(|edit| std::cmp::Reverse(edit.range.start));
    let mut out = content.to_string();
    for edit in ordered {
        let start = edit.range.start;
        let end = edit.range.end;
        if end <= out.len() && out.get(start..end) == Some(edit.before.as_str()) {
            out.replace_range(start..end, &edit.after);
        }
    }
    out
}
