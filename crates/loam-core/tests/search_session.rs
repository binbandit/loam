//! LOA-93: generation-based switcher streaming.

use loam_core::search::{
    Frecency, SwitchBatch, SwitchRecord, Switcher, SwitcherError, SwitcherSession,
};

const NOW: i64 = 1_752_000_000_000;

fn seeded_session(count: usize) -> SwitcherSession {
    let mut switcher = Switcher::new();
    for i in 0..count {
        switcher.insert_record(
            format!("notes/note-{i:04}.md"),
            SwitchRecord {
                title: format!("Note {i:04} garden"),
                aliases: Vec::new(),
                headings: vec![format!("Heading {i}")],
            },
        );
    }
    SwitcherSession::new(switcher)
}

fn frecency() -> Frecency {
    Frecency::load(std::path::Path::new("/nonexistent/frecency.json"))
}

/// AC1 (mechanism; the SLO itself is gated by loam-bench in CI): timing is
/// instrumented per run and the first batch never lags the total.
#[test]
fn timing_is_instrumented_per_run() {
    let mut session = seeded_session(2000);
    let generation = session.generation().supersede();
    let mut batches: Vec<SwitchBatch> = Vec::new();
    let (hits, timing) = session
        .run(generation, &frecency(), NOW, "garden", 10, &mut |batch| {
            batches.push(batch)
        })
        .expect("run");

    assert_eq!(timing.generation, generation);
    assert_eq!(timing.records, 2000);
    assert!(timing.first_batch_ms <= timing.total_ms);
    assert!(!hits.is_empty());
    assert!(
        batches.len() >= 2,
        "interim + final batches: {}",
        batches.len()
    );
    let done: Vec<&SwitchBatch> = batches.iter().filter(|b| b.done).collect();
    assert_eq!(done.len(), 1, "exactly one authoritative final batch");
    assert_eq!(done[0].hits, hits, "final batch equals the returned result");
    assert!(
        batches.iter().all(|b| b.generation == generation),
        "all batches tagged with the run's generation"
    );
}

/// AC2: rapid queries — only the newest generation completes; a superseded
/// run stops without ever emitting `done`.
#[test]
fn only_the_newest_generation_completes() {
    let mut session = seeded_session(5000);
    let handle = session.generation();

    let first_generation = handle.supersede();
    let supersede_from_sink = handle.clone();
    let mut first_batches: Vec<SwitchBatch> = Vec::new();
    let result = session.run(
        first_generation,
        &frecency(),
        NOW,
        "garden",
        10,
        &mut |batch| {
            // A "keystroke" lands mid-stream: supersede generation 1.
            supersede_from_sink.supersede();
            first_batches.push(batch);
        },
    );
    assert!(matches!(result, Err(SwitcherError::Cancelled)));
    assert!(
        first_batches.iter().all(|b| !b.done),
        "a superseded run never emits done: {first_batches:?}"
    );

    // The newest generation runs to completion.
    let second_generation = handle.current();
    let mut second_batches: Vec<SwitchBatch> = Vec::new();
    let (hits, _) = session
        .run(
            second_generation,
            &frecency(),
            NOW,
            "note 0001",
            10,
            &mut |batch| second_batches.push(batch),
        )
        .expect("newest generation completes");
    assert!(second_batches.iter().any(|b| b.done));
    assert_eq!(hits[0].path, "notes/note-0001.md");

    // Consumer-side filter: keep only newest-generation batches.
    let all: Vec<&SwitchBatch> = first_batches
        .iter()
        .chain(second_batches.iter())
        .filter(|b| b.generation == handle.current())
        .collect();
    assert!(all.iter().all(|b| b.generation == second_generation));
    assert!(all.iter().any(|b| b.done), "newest generation displayed");
}

/// A run started with a stale generation id cancels immediately.
#[test]
fn stale_generation_cancels_immediately() {
    let mut session = seeded_session(100);
    let handle = session.generation();
    let stale = handle.supersede();
    handle.supersede(); // newer generation exists before the run starts
    let result = session.run(stale, &frecency(), NOW, "garden", 10, &mut |_| {
        panic!("stale run must not emit")
    });
    assert!(matches!(result, Err(SwitcherError::Cancelled)));
}

/// AC4: the empty query serves Recents from switcher records + frecency
/// only — no note bodies exist anywhere in the data it touches (the record
/// type carries title/aliases/headings exclusively).
#[test]
fn empty_query_produces_recents_without_bodies() {
    let mut session = seeded_session(3000);
    let mut recents = frecency();
    recents.record_open("notes/note-0042.md", NOW - 10);
    recents.record_open("notes/note-0007.md", NOW);

    let generation = session.generation().supersede();
    let mut batches: Vec<SwitchBatch> = Vec::new();
    let (hits, timing) = session
        .run(generation, &recents, NOW, "", 10, &mut |batch| {
            batches.push(batch)
        })
        .expect("run");

    assert_eq!(hits[0].path, "notes/note-0007.md", "most recent first");
    assert_eq!(hits[1].path, "notes/note-0042.md");
    assert_eq!(hits.len(), 10, "padded to limit with title-ordered records");
    assert_eq!(batches.len(), 1, "recents arrive as a single done batch");
    assert!(batches[0].done);
    // Structural guarantee: the matchable record type has no body field —
    // this constructor call is the compile-time proof.
    let _ = SwitchRecord {
        title: String::new(),
        aliases: Vec::new(),
        headings: Vec::new(),
    };
    assert!(timing.total_ms < 1000.0, "no IO-scale work on this path");
}
