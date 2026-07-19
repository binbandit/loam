# Switcher streaming, stability, and cancellation

How the core switcher (`loam_core::search`) delivers results (§3.5, LOA-93).
This is the contract the omnibar and any other consumer must follow.

## Generations

Every keystroke supersedes the previous query. `GenerationHandle::supersede()`
bumps the shared counter and returns the id to tag the next run with. An
in-flight run polls the counter between work chunks; once superseded it stops
with `Cancelled` and emits nothing further — a superseded run can never emit
its final batch.

**Consumer rule:** drop any batch whose `generation` is not the newest you
issued. The core guarantees only the newest generation completes, but interim
batches from a just-superseded run may still be in flight in your channel.

## Batches and result stability

- Interim batches (`done: false`) are **provisional** textual rankings.
  They only ever refine: hits may reorder or drop as later chunks surface
  better matches. Never treat them as final.
- The final batch (`done: true`) is emitted exactly once per completed run
  and is **authoritative**: it equals the non-streaming
  `switcher(query, limit)` result with the frecency blend applied.
- Results are deterministic: the same records, query, frecency state, and
  clock produce the same final batch (gated by the bench stability check).

## Empty query

An empty query returns the frecency *Recents* (decayed-weight order, §3.5),
padded with title-ordered records. This path touches only in-memory switcher
records and the frecency store — note bodies are never read.

## Timing and performance gates

`SwitchTiming` reports core-side `firstBatchMs` and `totalMs` per run; the
IPC transport (E06) layers its own leg on top. The CI perf-smoke job runs
`cargo run --release -p loam-bench -- switcher --check` on the deterministic
bench-10k record set and fails on:

- first-batch p95 > 15 ms (core's share of the 30 ms keystroke budget),
- total p95 > 30 ms, empty-query p95 > 5 ms,
- any metric regressing >10% over `crates/loam-bench/baselines/switcher.json`.

Refresh baselines deliberately with
`cargo run --release -p loam-bench -- switcher --write-baseline` and commit
the diff.
