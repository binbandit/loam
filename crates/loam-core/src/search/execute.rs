//! Ranked search execution (D6, §3.6, LOA-82): compiled queries run against
//! a reader handle that is independent of the writer, return grouped hits
//! with bounded highlighted snippet lines, page by cursor, and can be
//! cancelled between phases without corrupting anything.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tantivy::collector::{Count, TopDocs};
use tantivy::schema::Value;
use tantivy::{Index, TantivyDocument};

use super::query::{ParsedQuery, QueryNode, compile_query, parse_query};
use super::schema::{FIELD_BODY, FIELD_PATH, FIELD_TITLE};

#[derive(Debug, thiserror::Error)]
pub enum ExecuteError {
    #[error("search execution failed: {0}")]
    Tantivy(#[from] tantivy::TantivyError),
    #[error("query failed to compile: {0}")]
    Compile(#[from] super::query::CompileError),
    #[error("request superseded")]
    Cancelled,
}

/// Search availability, returned WITH results so the UI can badge partial
/// states (AC5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchStatus {
    Ready,
    /// A rebuild is filling the index; results may be incomplete.
    Rebuilding,
}

/// Byte range into the snippet LINE text — always on char boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightRange {
    pub start: usize,
    pub end: usize,
}

/// One highlighted line of context from the note body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetLine {
    /// 1-based line number in the note body.
    pub line: usize,
    pub text: String,
    pub ranges: Vec<HighlightRange>,
}

/// One result note (documents are per-note, so hits arrive pre-grouped).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub score: f32,
    pub snippets: Vec<SnippetLine>,
}

/// A page of results. `cursor` continues the SAME ranking when present;
/// cursors are valid within one index generation.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub hits: Vec<SearchHit>,
    pub total: u64,
    pub cursor: Option<u32>,
    pub status: SearchStatus,
    pub diagnostics: Vec<super::query::QueryDiagnostic>,
}

pub const MAX_SEARCH_LIMIT: u32 = 200;
const MAX_SNIPPET_LINES: usize = 3;
const MAX_SNIPPET_CHARS: usize = 200;

/// Cheap cloneable read handle: searches never touch the writer, and the
/// rebuild flag travels with it (set by `rebuild_all`).
#[derive(Clone)]
pub struct SearchHandle {
    pub(super) index: Index,
    pub(super) rebuilding: Arc<AtomicBool>,
}

impl SearchHandle {
    pub fn status(&self) -> SearchStatus {
        if self.rebuilding.load(Ordering::Relaxed) {
            SearchStatus::Rebuilding
        } else {
            SearchStatus::Ready
        }
    }

    /// Execute one search request. `cancelled` is polled between phases and
    /// per hit; a superseded request returns `ExecuteError::Cancelled` and
    /// leaves the reader fully reusable.
    pub fn search_page(
        &self,
        query: &str,
        limit: u32,
        cursor: Option<u32>,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<SearchPage, ExecuteError> {
        let parsed = parse_query(query);
        if cancelled() {
            return Err(ExecuteError::Cancelled);
        }
        let compiled = compile_query(&parsed, &self.index)?;
        let limit = limit.clamp(1, MAX_SEARCH_LIMIT) as usize;
        let offset = cursor.unwrap_or(0) as usize;

        let reader = self.index.reader()?;
        let searcher = reader.searcher();
        if cancelled() {
            return Err(ExecuteError::Cancelled);
        }
        let (total, ranked) = searcher.search(
            &*compiled,
            &(
                Count,
                TopDocs::with_limit(limit)
                    .and_offset(offset)
                    .order_by_score(),
            ),
        )?;

        let schema = self.index.schema();
        let path_field = schema.get_field(FIELD_PATH).expect("path field");
        let title_field = schema.get_field(FIELD_TITLE).expect("title field");
        let body_field = schema.get_field(FIELD_BODY).expect("body field");
        let needles = positive_needles(&parsed);

        let mut hits = Vec::with_capacity(ranked.len());
        for (score, address) in &ranked {
            if cancelled() {
                return Err(ExecuteError::Cancelled);
            }
            let doc: TantivyDocument = searcher.doc(*address)?;
            let get = |field: tantivy::schema::Field| {
                doc.get_first(field)
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string()
            };
            let body = get(body_field);
            hits.push(SearchHit {
                path: get(path_field),
                title: get(title_field),
                score: *score,
                snippets: snippet_lines(&body, &needles),
            });
        }
        // Tie-breaking: tantivy orders (score desc, doc address asc), which
        // is deterministic within an index generation — the same window a
        // cursor is valid for. Re-sorting per page would shuffle ties across
        // page boundaries, so the collector order is kept as-is.
        let next = offset + hits.len();
        Ok(SearchPage {
            cursor: (next < total).then_some(next as u32),
            hits,
            total: total as u64,
            status: self.status(),
            diagnostics: parsed.diagnostics,
        })
    }
}

/// Positive text needles (terms + phrases) for snippet highlighting —
/// negated subtrees contribute nothing to highlights.
fn positive_needles(parsed: &ParsedQuery) -> Vec<String> {
    fn walk(node: &QueryNode, out: &mut Vec<String>) {
        match node {
            QueryNode::Term { text, .. } | QueryNode::Phrase { text, .. } => {
                if !text.trim().is_empty() {
                    out.push(text.to_lowercase());
                }
            }
            QueryNode::And { nodes } | QueryNode::Or { nodes } => {
                for child in nodes {
                    walk(child, out);
                }
            }
            QueryNode::Not { .. } | QueryNode::Filter { .. } => {}
        }
    }
    let mut out = Vec::new();
    if let Some(ast) = &parsed.ast {
        walk(ast, &mut out);
    }
    out
}

/// Case-insensitive substring scan that only ever produces char-boundary
/// byte ranges into the ORIGINAL haystack. Comparison is per-char primary
/// lowercase, so ranges stay aligned even where lowercasing changes byte
/// lengths.
fn find_ci(haystack: &str, needle_lower: &str) -> Vec<HighlightRange> {
    let needle: Vec<char> = needle_lower.chars().collect();
    if needle.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let boundaries: Vec<usize> = haystack.char_indices().map(|(i, _)| i).collect();
    for &start in &boundaries {
        let mut probe = haystack[start..].chars();
        let mut consumed = 0;
        let mut matched = true;
        for expected in &needle {
            match probe.next() {
                Some(actual)
                    if actual.to_lowercase().next() == Some(*expected) || actual == *expected =>
                {
                    consumed += actual.len_utf8();
                }
                _ => {
                    matched = false;
                    break;
                }
            }
        }
        if matched {
            out.push(HighlightRange {
                start,
                end: start + consumed,
            });
        }
    }
    out
}

/// Up to [`MAX_SNIPPET_LINES`] matching body lines, each bounded to
/// [`MAX_SNIPPET_CHARS`] chars with in-bounds highlight ranges.
fn snippet_lines(body: &str, needles: &[String]) -> Vec<SnippetLine> {
    let mut out = Vec::new();
    for (index, line) in body.lines().enumerate() {
        if out.len() >= MAX_SNIPPET_LINES {
            break;
        }
        let mut ranges: Vec<HighlightRange> = needles
            .iter()
            .flat_map(|needle| find_ci(line, needle))
            .collect();
        if ranges.is_empty() {
            continue;
        }
        ranges.sort_by_key(|r| (r.start, r.end));
        ranges.dedup();

        // Bound the line, keeping only ranges that survive whole.
        let (text, cap) = if line.chars().count() > MAX_SNIPPET_CHARS {
            let cap = line
                .char_indices()
                .nth(MAX_SNIPPET_CHARS)
                .map(|(i, _)| i)
                .unwrap_or(line.len());
            (line[..cap].to_string(), cap)
        } else {
            (line.to_string(), line.len())
        };
        ranges.retain(|r| r.end <= cap);
        out.push(SnippetLine {
            line: index + 1,
            text,
            ranges,
        });
    }
    out
}
