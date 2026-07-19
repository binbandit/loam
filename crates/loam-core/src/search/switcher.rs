//! Nucleo-based switcher matching (§3.5, LOA-87): in-memory fuzzy matching
//! over titles, aliases, paths, and headings with explicit field boosts,
//! chunked streaming, and cancellation. Frecency blending is LOA-92; this
//! module is pure textual relevance.

use std::collections::BTreeMap;

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;

use super::execute::HighlightRange;
use crate::index::{IndexReader, QueryError};

/// Which record field produced the match.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchField {
    Title,
    Alias,
    Path,
    Heading,
}

/// Explicit field boosts (scope): title strongest, then alias, path, heading.
pub const TITLE_MATCH_BOOST: f32 = 1.0;
pub const ALIAS_MATCH_BOOST: f32 = 0.9;
pub const PATH_MATCH_BOOST: f32 = 0.6;
pub const HEADING_MATCH_BOOST: f32 = 0.5;

/// One switcher result.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchHit {
    pub path: String,
    /// The text that matched (title, alias, path, or heading).
    pub display: String,
    pub field: MatchField,
    pub score: f32,
    /// Byte ranges into `display`, always on char boundaries.
    pub ranges: Vec<HighlightRange>,
}

/// One note's matchable metadata.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SwitchRecord {
    pub title: String,
    pub aliases: Vec<String>,
    pub headings: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum SwitcherError {
    #[error("metadata query failed: {0}")]
    Metadata(#[from] QueryError),
    #[error("query superseded")]
    Cancelled,
}

/// The in-memory switcher matcher. Records key by path (BTreeMap: stable,
/// deterministic iteration). Incremental updates mutate single entries — no
/// full restart needed.
pub struct Switcher {
    records: BTreeMap<String, SwitchRecord>,
    matcher: Matcher,
}

const STREAM_CHUNK: usize = 512;

fn record_for(metadata: &IndexReader, path: &str) -> Result<SwitchRecord, QueryError> {
    let title = std::path::Path::new(path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let headings = metadata
        .headings_of(path)?
        .into_iter()
        .map(|h| h.text)
        .collect();
    // Aliases are filled in by the callers (bulk walk or per-file filter).
    Ok(SwitchRecord {
        title,
        aliases: Vec::new(),
        headings,
    })
}

impl Switcher {
    pub fn new() -> Self {
        Self {
            records: BTreeMap::new(),
            matcher: Matcher::new(Config::DEFAULT),
        }
    }

    /// Build the full record set from E04 metadata.
    pub fn from_metadata(metadata: &IndexReader) -> Result<Self, SwitcherError> {
        let mut switcher = Self::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = metadata.files_page(crate::index::MAX_PAGE_SIZE, cursor.as_deref())?;
            let Some(last) = page.last() else { break };
            cursor = Some(last.path.clone());
            for file in &page {
                let record = record_for(metadata, &file.path)?;
                switcher.records.insert(file.path.clone(), record);
            }
        }
        // Aliases arrive in bulk (cheaper than per-file queries).
        let mut alias_cursor = None;
        loop {
            let page = metadata.aliases_page(crate::index::MAX_PAGE_SIZE, alias_cursor.as_ref())?;
            let Some(last) = page.last() else { break };
            alias_cursor = Some(last.clone());
            for row in page {
                if let Some(record) = switcher.records.get_mut(&row.path) {
                    record.alias_push(row.alias);
                }
            }
        }
        Ok(switcher)
    }

    /// Incremental update for one path (create/modify): re-derive from
    /// metadata without rebuilding the set.
    pub fn upsert(&mut self, metadata: &IndexReader, path: &str) -> Result<(), SwitcherError> {
        let mut record = record_for(metadata, path)?;
        // Per-file aliases: filter the (small) alias listing.
        let mut alias_cursor = None;
        loop {
            let page = metadata.aliases_page(crate::index::MAX_PAGE_SIZE, alias_cursor.as_ref())?;
            let Some(last) = page.last() else { break };
            alias_cursor = Some(last.clone());
            for row in page {
                if row.path == path {
                    record.alias_push(row.alias);
                }
            }
        }
        self.records.insert(path.to_string(), record);
        Ok(())
    }

    /// Insert a fully-formed record directly (bench harness, tests, bulk
    /// loaders that already hold the metadata).
    pub fn insert_record(&mut self, path: impl Into<String>, record: SwitchRecord) {
        self.records.insert(path.into(), record);
    }

    pub fn remove(&mut self, path: &str) {
        self.records.remove(path);
    }

    pub fn rename(&mut self, from: &str, to: &str) {
        if let Some(mut record) = self.records.remove(from) {
            record.title = std::path::Path::new(to)
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_else(|| to.to_string());
            self.records.insert(to.to_string(), record);
        }
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Match `query` over all records, streaming interim top-`limit`
    /// snapshots to `on_batch` after each chunk. `cancelled` is polled per
    /// chunk: a superseded query stops immediately with `Cancelled` and
    /// emits nothing further.
    pub fn query_streaming(
        &mut self,
        query: &str,
        limit: usize,
        cancelled: &dyn Fn() -> bool,
        on_batch: &mut dyn FnMut(&[SwitchHit]),
    ) -> Result<Vec<SwitchHit>, SwitcherError> {
        if query.trim().is_empty() {
            // Empty query: deterministic title order (frecency recents in
            // LOA-92 will replace this ordering).
            let hits: Vec<SwitchHit> = self
                .records
                .iter()
                .map(|(path, record)| SwitchHit {
                    path: path.clone(),
                    display: record.title.clone(),
                    field: MatchField::Title,
                    score: 0.0,
                    ranges: Vec::new(),
                })
                .take(limit)
                .collect();
            on_batch(&hits);
            return Ok(hits);
        }

        let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
        let mut top: Vec<SwitchHit> = Vec::new();
        let mut buf = Vec::new();
        let mut indices = Vec::new();

        let records: Vec<(&String, &SwitchRecord)> = self.records.iter().collect();
        for chunk in records.chunks(STREAM_CHUNK) {
            if cancelled() {
                return Err(SwitcherError::Cancelled);
            }
            for (path, record) in chunk {
                let mut best: Option<SwitchHit> = None;
                let mut consider =
                    |field: MatchField, text: &str, boost: f32, matcher: &mut Matcher| {
                        let haystack = Utf32Str::new(text, &mut buf);
                        indices.clear();
                        if let Some(raw) = pattern.indices(haystack, matcher, &mut indices) {
                            let score = raw as f32 * boost;
                            if best.as_ref().is_none_or(|b| score > b.score) {
                                best = Some(SwitchHit {
                                    path: (*path).clone(),
                                    display: text.to_string(),
                                    field,
                                    score,
                                    ranges: char_indices_to_ranges(text, &indices),
                                });
                            }
                        }
                    };
                consider(
                    MatchField::Title,
                    &record.title,
                    TITLE_MATCH_BOOST,
                    &mut self.matcher,
                );
                for alias in &record.aliases {
                    consider(
                        MatchField::Alias,
                        alias,
                        ALIAS_MATCH_BOOST,
                        &mut self.matcher,
                    );
                }
                consider(MatchField::Path, path, PATH_MATCH_BOOST, &mut self.matcher);
                for heading in &record.headings {
                    consider(
                        MatchField::Heading,
                        heading,
                        HEADING_MATCH_BOOST,
                        &mut self.matcher,
                    );
                }
                if let Some(hit) = best {
                    top.push(hit);
                }
            }
            // Keep only the running top-`limit`, stable order.
            sort_hits(&mut top);
            top.truncate(limit);
            on_batch(&top);
        }
        Ok(top)
    }

    /// Convenience non-streaming form: `switcher(query, limit)`.
    pub fn query(
        &mut self,
        query: &str,
        limit: usize,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<SwitchHit>, SwitcherError> {
        self.query_streaming(query, limit, cancelled, &mut |_| {})
    }

    /// Frecency-blended query (§3.5, LOA-92): textual score × (1 + bounded
    /// per-device boost). An empty query returns the frecency RECENTS first
    /// (deterministic order), padded with title-ordered records.
    pub fn query_with_frecency(
        &mut self,
        frecency: &super::frecency::Frecency,
        now_ms: i64,
        query: &str,
        limit: usize,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<SwitchHit>, SwitcherError> {
        if query.trim().is_empty() {
            let mut hits: Vec<SwitchHit> = Vec::new();
            for recent in frecency.recent(limit, now_ms) {
                if let Some(record) = self.records.get(&recent.path) {
                    hits.push(SwitchHit {
                        path: recent.path.clone(),
                        display: record.title.clone(),
                        field: MatchField::Title,
                        score: recent.weight as f32,
                        ranges: Vec::new(),
                    });
                }
            }
            if hits.len() < limit {
                for (path, record) in self.records.iter() {
                    if hits.len() >= limit {
                        break;
                    }
                    if hits.iter().any(|h| &h.path == path) {
                        continue;
                    }
                    hits.push(SwitchHit {
                        path: path.clone(),
                        display: record.title.clone(),
                        field: MatchField::Title,
                        score: 0.0,
                        ranges: Vec::new(),
                    });
                }
            }
            return Ok(hits);
        }

        // Over-fetch textual candidates so a boost cannot promote a hit that
        // was cut just below the limit.
        let mut hits = self.query(query, limit.saturating_mul(2).max(limit + 8), cancelled)?;
        for hit in &mut hits {
            hit.score *= 1.0 + frecency.boost(&hit.path, now_ms);
        }
        sort_hits(&mut hits);
        hits.truncate(limit);
        Ok(hits)
    }
}

impl Default for Switcher {
    fn default() -> Self {
        Self::new()
    }
}

impl SwitchRecord {
    fn alias_push(&mut self, alias: String) {
        if !self.aliases.contains(&alias) {
            self.aliases.push(alias);
        }
    }
}

/// Deterministic ranking: score desc, then path asc, then field order.
fn sort_hits(hits: &mut [SwitchHit]) {
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.path.cmp(&b.path))
    });
}

/// Nucleo reports CHAR indices into the haystack; convert contiguous runs to
/// byte ranges of the original string — always valid char boundaries.
fn char_indices_to_ranges(text: &str, char_indices: &[u32]) -> Vec<HighlightRange> {
    if char_indices.is_empty() {
        return Vec::new();
    }
    let mut sorted: Vec<u32> = char_indices.to_vec();
    sorted.sort_unstable();
    sorted.dedup();

    let byte_of: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
    let char_len_at = |char_index: usize| {
        text[byte_of[char_index]..]
            .chars()
            .next()
            .map(|c| c.len_utf8())
            .unwrap_or(0)
    };

    let mut out = Vec::new();
    let mut run_start = sorted[0] as usize;
    let mut run_end = run_start; // inclusive char index
    for &index in &sorted[1..] {
        let index = index as usize;
        if index == run_end + 1 {
            run_end = index;
        } else {
            out.push(HighlightRange {
                start: byte_of[run_start],
                end: byte_of[run_end] + char_len_at(run_end),
            });
            run_start = index;
            run_end = index;
        }
    }
    out.push(HighlightRange {
        start: byte_of[run_start],
        end: byte_of[run_end] + char_len_at(run_end),
    });
    out
}
