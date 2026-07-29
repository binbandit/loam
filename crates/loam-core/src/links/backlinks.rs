//! Linked mentions with context (LOA-113, §3.4).
//!
//! The index knows *where* every inbound link is; the panel needs enough
//! text around it to be readable, and an exact range to jump to. Reading is
//! bounded on both axes — a fixed number of lines per mention, and a cap on
//! mentions per source note — so one enormous note cannot stall the panel.
//!
//! Every group carries the source note's hash at read time, so the UI can
//! tell a stale snippet from a fresh one after the file changes underneath.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::vault;

/// How many lines of context sit either side of a mention.
const CONTEXT_LINES: usize = 1;
/// Upper bound on mentions rendered per source note.
pub const MAX_MENTIONS_PER_NOTE: usize = 50;

/// One inbound link, with the text around it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    /// Target text exactly as written in the source.
    pub target: String,
    /// Byte range of the link in the source note — where clicking lands.
    pub jump_start: usize,
    pub jump_end: usize,
    /// 1-based line of the mention.
    pub line: u32,
    /// The surrounding lines, joined; what the panel renders.
    pub context: String,
    /// Byte range of the link *within* `context`, for highlighting.
    pub match_start: usize,
    pub match_end: usize,
}

/// Every mention inside one source note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionGroup {
    pub source_path: String,
    /// Hash of the source when the snippets were read (staleness check).
    pub source_hash: String,
    pub mentions: Vec<Mention>,
    /// Mentions beyond `MAX_MENTIONS_PER_NOTE`, not rendered.
    pub truncated: u32,
}

/// A raw inbound link as the index reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionRef {
    pub source_path: String,
    pub target: String,
    pub start: usize,
    pub end: usize,
}

/// Builds display-ready groups, reading each source note exactly once.
///
/// Source notes are ordered by path and mentions by position, so the panel
/// renders the same way for the same vault on every machine. A note that
/// cannot be read is skipped rather than failing the whole query — one
/// unreadable file must not empty the panel.
pub fn mentions_with_context(root: &Path, refs: &[MentionRef]) -> Vec<MentionGroup> {
    let mut paths: Vec<&str> = refs.iter().map(|r| r.source_path.as_str()).collect();
    paths.sort_unstable();
    paths.dedup();

    let mut groups = Vec::new();
    for path in paths {
        let Ok(doc) = vault::note_read(root, path) else {
            continue;
        };
        let Some(content) = doc.content else {
            continue;
        };

        let mut owned: Vec<&MentionRef> = refs.iter().filter(|r| r.source_path == path).collect();
        owned.sort_by_key(|r| r.start);
        let truncated = owned.len().saturating_sub(MAX_MENTIONS_PER_NOTE) as u32;

        let mentions: Vec<Mention> = owned
            .into_iter()
            .take(MAX_MENTIONS_PER_NOTE)
            .filter_map(|reference| build(&content, reference))
            .collect();
        if mentions.is_empty() {
            continue;
        }
        groups.push(MentionGroup {
            source_path: path.to_string(),
            source_hash: doc.hash.as_str().to_string(),
            mentions,
            truncated,
        });
    }
    groups
}

/// Extracts one mention's context window and its offsets inside it.
fn build(content: &str, reference: &MentionRef) -> Option<Mention> {
    if reference.end > content.len() || reference.start > reference.end {
        // The index is behind the file; drop this mention rather than slice
        // at a boundary that no longer exists.
        return None;
    }
    if !content.is_char_boundary(reference.start) || !content.is_char_boundary(reference.end) {
        return None;
    }

    let line_start = content[..reference.start]
        .rfind('\n')
        .map_or(0, |index| index + 1);
    let line = content[..line_start].matches('\n').count() as u32 + 1;

    let mut window_start = line_start;
    for _ in 0..CONTEXT_LINES {
        match content[..window_start].trim_end_matches('\n').rfind('\n') {
            Some(index) => window_start = index + 1,
            None => {
                window_start = 0;
                break;
            }
        }
    }
    let mut window_end = content[reference.end..]
        .find('\n')
        .map_or(content.len(), |index| reference.end + index);
    for _ in 0..CONTEXT_LINES {
        match content[window_end + 1..].find('\n') {
            Some(index) => window_end = window_end + 1 + index,
            None => {
                window_end = content.len();
                break;
            }
        }
    }

    let context = content[window_start..window_end].trim_end().to_string();
    Some(Mention {
        target: reference.target.clone(),
        jump_start: reference.start,
        jump_end: reference.end,
        line,
        match_start: reference.start - window_start,
        match_end: reference.end - window_start,
        context,
    })
}
