//! Generation-based switcher sessions (LOA-93): every keystroke supersedes
//! the previous query, and only the newest generation's results survive.
//!
//! # Result stability & cancellation semantics
//!
//! - Each `run` is tagged with a generation. [`GenerationHandle::supersede`]
//!   bumps the current generation; any in-flight run notices between chunks
//!   and stops with `Cancelled`, emitting nothing further.
//! - Interim batches (`done: false`) are PROVISIONAL textual rankings that
//!   only ever refine — hits may reorder or drop as better matches arrive.
//! - The final batch (`done: true`) is authoritative: identical to the
//!   non-streaming `switcher(query, limit)` result with frecency applied.
//! - Consumers must drop batches whose `generation` is not the newest they
//!   have issued; the core guarantees a superseded run never emits `done`.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use serde::Serialize;

use super::frecency::Frecency;
use super::switcher::{SwitchHit, Switcher, SwitcherError};

/// One streamed batch, tagged with its generation.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchBatch {
    pub generation: u64,
    /// False for provisional interim batches; true exactly once, on the
    /// authoritative final result.
    pub done: bool,
    pub hits: Vec<SwitchHit>,
}

/// Core-side timing instrumentation. The IPC transport (E06) adds its own
/// leg on top; this measures what leaves the core.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchTiming {
    pub generation: u64,
    /// Milliseconds until the first batch reached the sink.
    pub first_batch_ms: f64,
    pub total_ms: f64,
    pub records: usize,
}

/// Shared generation counter: clone freely, bump from anywhere (the UI
/// thread supersedes while a worker runs the query).
#[derive(Debug, Clone, Default)]
pub struct GenerationHandle(Arc<AtomicU64>);

impl GenerationHandle {
    pub fn current(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }

    /// Start a new generation, invalidating all older runs. Returns the new
    /// generation id to tag the next run with.
    pub fn supersede(&self) -> u64 {
        self.0.fetch_add(1, Ordering::Relaxed) + 1
    }
}

/// A switcher session: the matcher plus the generation counter.
pub struct SwitcherSession {
    switcher: Switcher,
    generation: GenerationHandle,
}

impl SwitcherSession {
    pub fn new(switcher: Switcher) -> Self {
        Self {
            switcher,
            generation: GenerationHandle::default(),
        }
    }

    pub fn generation(&self) -> GenerationHandle {
        self.generation.clone()
    }

    pub fn switcher_mut(&mut self) -> &mut Switcher {
        &mut self.switcher
    }

    /// Run one query under `generation`. Interim textual batches stream to
    /// `sink` (`done: false`); the frecency-blended final result is emitted
    /// once as `done: true` and returned with core timing.
    pub fn run(
        &mut self,
        generation: u64,
        frecency: &Frecency,
        now_ms: i64,
        query: &str,
        limit: usize,
        sink: &mut dyn FnMut(SwitchBatch),
    ) -> Result<(Vec<SwitchHit>, SwitchTiming), SwitcherError> {
        let started = Instant::now();
        let records = self.switcher.len();
        let handle = self.generation.clone();
        let cancelled = move || handle.current() != generation;
        if cancelled() {
            return Err(SwitcherError::Cancelled);
        }

        let mut first_batch_ms: Option<f64> = None;
        let hits = if query.trim().is_empty() {
            // Recents come from frecency + record titles only — note bodies
            // are never touched on this path (they are not even in memory).
            self.switcher
                .query_with_frecency(frecency, now_ms, query, limit, &cancelled)?
        } else {
            let mut interim_sink = |batch: &[SwitchHit]| {
                if first_batch_ms.is_none() {
                    first_batch_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
                }
                sink(SwitchBatch {
                    generation,
                    done: false,
                    hits: batch.to_vec(),
                });
            };
            // Stream textual rankings, then refine with frecency for the
            // authoritative final batch.
            self.switcher.query_streaming(
                query,
                limit.max(8) * 2,
                &cancelled,
                &mut interim_sink,
            )?;
            self.switcher
                .query_with_frecency(frecency, now_ms, query, limit, &cancelled)?
        };

        if cancelled() {
            return Err(SwitcherError::Cancelled);
        }
        let total_ms = started.elapsed().as_secs_f64() * 1000.0;
        sink(SwitchBatch {
            generation,
            done: true,
            hits: hits.clone(),
        });
        Ok((
            hits,
            SwitchTiming {
                generation,
                first_batch_ms: first_batch_ms.unwrap_or(total_ms),
                total_ms,
                records,
            },
        ))
    }
}
