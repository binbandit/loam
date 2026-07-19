//! Deterministic frecency (§3.5/§3.6, LOA-92): per-device note-open history
//! with exponential decay, blended into switcher scores as a BOUNDED
//! multiplier so textual relevance always dominates. Every API takes the
//! clock explicitly — behavior is a pure function of recorded timestamps,
//! never of wall time. Data lives in per-device app-data (private, never in
//! the vault) and is disposable.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Decay half-life: an open loses half its weight every 7 days.
pub const HALF_LIFE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Accumulated weight cap — repeated opens saturate here (AC1 "bounded").
pub const MAX_WEIGHT: f64 = 8.0;
/// Maximum score multiplier contribution: textual * (1 + boost), boost ≤ 0.3.
pub const MAX_BOOST: f32 = 0.3;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    weight: f64,
    last_ms: i64,
    opens: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileFormat {
    version: u32,
    entries: BTreeMap<String, Entry>,
}

#[derive(Debug, thiserror::Error)]
pub enum FrecencyError {
    #[error("failed to persist frecency data: {0}")]
    Io(#[from] std::io::Error),
}

/// A recent note for the empty-query switcher view.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentNote {
    pub path: String,
    pub weight: f64,
    pub last_ms: i64,
}

/// Per-device frecency store.
pub struct Frecency {
    file: FileFormat,
    path: PathBuf,
}

fn decay(weight: f64, elapsed_ms: i64) -> f64 {
    if elapsed_ms <= 0 {
        return weight;
    }
    weight * 0.5f64.powf(elapsed_ms as f64 / HALF_LIFE_MS as f64)
}

impl Frecency {
    /// Load from `path`. Missing or corrupt data starts empty — the store is
    /// disposable device state, never worth blocking on.
    pub fn load(path: &Path) -> Self {
        let file = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            file,
            path: path.to_path_buf(),
        }
    }

    /// Persist atomically (temp + rename): a crash never corrupts history.
    pub fn save(&self) -> Result<(), FrecencyError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = self.path.with_extension("json.tmp");
        let body = serde_json::to_string_pretty(&self.file).expect("serializes");
        std::fs::write(&temp, body)?;
        std::fs::rename(&temp, &self.path)?;
        Ok(())
    }

    /// Record a note open at `now_ms`: decay the old weight to now, add 1,
    /// cap. Deterministic in (previous state, now_ms).
    pub fn record_open(&mut self, path: &str, now_ms: i64) {
        let entry = self.file.entries.entry(path.to_string()).or_insert(Entry {
            weight: 0.0,
            last_ms: now_ms,
            opens: 0,
        });
        let decayed = decay(entry.weight, now_ms - entry.last_ms);
        entry.weight = (decayed + 1.0).min(MAX_WEIGHT);
        entry.last_ms = now_ms;
        entry.opens += 1;
    }

    /// The bounded score multiplier contribution for a path at `now_ms`.
    pub fn boost(&self, path: &str, now_ms: i64) -> f32 {
        match self.file.entries.get(path) {
            Some(entry) => {
                let effective = decay(entry.weight, now_ms - entry.last_ms);
                ((effective / MAX_WEIGHT) as f32 * MAX_BOOST).min(MAX_BOOST)
            }
            None => 0.0,
        }
    }

    /// Rename preserves history under the new path.
    pub fn rename(&mut self, from: &str, to: &str) {
        if let Some(entry) = self.file.entries.remove(from) {
            self.file.entries.insert(to.to_string(), entry);
        }
    }

    /// Delete drops stale history.
    pub fn remove(&mut self, path: &str) {
        self.file.entries.remove(path);
    }

    /// Recent notes for the empty query: effective weight desc, then most
    /// recent, then path — fully deterministic.
    pub fn recent(&self, limit: usize, now_ms: i64) -> Vec<RecentNote> {
        let mut recents: Vec<RecentNote> = self
            .file
            .entries
            .iter()
            .map(|(path, entry)| RecentNote {
                path: path.clone(),
                weight: decay(entry.weight, now_ms - entry.last_ms),
                last_ms: entry.last_ms,
            })
            .collect();
        recents.sort_by(|a, b| {
            b.weight
                .partial_cmp(&a.weight)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.last_ms.cmp(&a.last_ms))
                .then_with(|| a.path.cmp(&b.path))
        });
        recents.truncate(limit);
        recents
    }

    pub fn len(&self) -> usize {
        self.file.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.file.entries.is_empty()
    }
}
