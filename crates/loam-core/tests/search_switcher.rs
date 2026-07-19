//! LOA-87: Nucleo note and heading matching.

use std::sync::atomic::{AtomicU32, Ordering};

use loam_core::index::{IndexDb, ReindexOutcome, Reindexer};
use loam_core::search::{MatchField, Switcher};
use loam_core::vault::{ChangeOrigin, EventKind, VaultEvent};

fn event(path: &str, kind: EventKind) -> VaultEvent {
    VaultEvent {
        path: path.to_string(),
        kind,
        origin: ChangeOrigin::External,
    }
}

fn never() -> impl Fn() -> bool {
    || false
}

struct Setup {
    _vault: tempfile::TempDir,
    _out: tempfile::TempDir,
    root: std::path::PathBuf,
    reindexer: Reindexer,
    db_path: std::path::PathBuf,
}

fn setup() -> Setup {
    let vault = tempfile::tempdir().expect("vault");
    let out = tempfile::tempdir().expect("out");
    std::fs::create_dir_all(vault.path().join("projects/deep")).expect("mkdir");
    let notes: [(&str, &str); 4] = [
        (
            "meeting.md",
            "---\naliases: [Standup Notes]\n---\n\n# Meeting\n\n## Agenda Review\n",
        ),
        ("projects/deep/met.md", "# Met\n\nShort note.\n"),
        (
            "projects/metrics.md",
            "# Metrics Dashboard\n\n## Meeting cadence\n",
        ),
        ("café-métro.md", "# Café Métro\n\n## Ligne Défense\n"),
    ];
    for (path, content) in notes {
        std::fs::write(vault.path().join(path), content).expect("note");
    }
    let root = vault.path().canonicalize().expect("canonical");
    let db_path = out.path().join("index.db");
    let db = IndexDb::open(&db_path).expect("db");
    let mut reindexer = Reindexer::new(db, root.clone());
    for (path, _) in notes {
        let outcome = reindexer
            .apply(&event(path, EventKind::Created))
            .expect("index");
        assert!(matches!(outcome, ReindexOutcome::Indexed { .. }));
    }
    Setup {
        root,
        reindexer,
        db_path,
        _vault: vault,
        _out: out,
    }
}

fn reader(setup: &Setup) -> loam_core::index::IndexReader {
    loam_core::index::IndexReader::open(&setup.db_path).expect("metadata")
}

/// AC1: an exact title match outranks fuzzy path-only matches.
#[test]
fn exact_title_outranks_fuzzy_path() {
    let setup = setup();
    let mut switcher = Switcher::from_metadata(&reader(&setup)).expect("build");
    assert_eq!(switcher.len(), 4);

    let hits = switcher.query("meeting", 10, &never()).expect("query");
    assert_eq!(hits[0].path, "meeting.md", "exact title first: {hits:?}");
    assert_eq!(hits[0].field, MatchField::Title);
    assert!(
        hits.iter().any(|h| h.path == "projects/metrics.md"),
        "heading match still surfaces"
    );

    // A path-fragment query still finds deep files — via the path field.
    let hits = switcher.query("deep/met", 10, &never()).expect("query");
    assert_eq!(hits[0].path, "projects/deep/met.md");
    assert_eq!(hits[0].field, MatchField::Path);
}

/// AC2: alias and heading matches identify their source field and text.
#[test]
fn alias_and_heading_matches_identify_their_field() {
    let setup = setup();
    let mut switcher = Switcher::from_metadata(&reader(&setup)).expect("build");

    let hits = switcher.query("standup", 10, &never()).expect("query");
    assert_eq!(hits[0].path, "meeting.md");
    assert_eq!(hits[0].field, MatchField::Alias);
    assert_eq!(hits[0].display, "Standup Notes");

    let hits = switcher
        .query("agenda review", 10, &never())
        .expect("query");
    assert_eq!(hits[0].path, "meeting.md");
    assert_eq!(hits[0].field, MatchField::Heading);
    assert_eq!(hits[0].display, "Agenda Review");
}

/// AC3: incremental metadata changes appear without a full restart.
#[test]
fn incremental_changes_appear_without_restart() {
    let mut setup = setup();
    let metadata = reader(&setup);
    let mut switcher = Switcher::from_metadata(&metadata).expect("build");

    // New note arrives through the incremental path.
    std::fs::write(
        setup.root.join("fresh.md"),
        "---\naliases: Newcomer\n---\n\n# Fresh Arrival\n",
    )
    .expect("note");
    setup
        .reindexer
        .apply(&event("fresh.md", EventKind::Created))
        .expect("index");
    switcher.upsert(&metadata, "fresh.md").expect("upsert");
    let hits = switcher.query("newcomer", 10, &never()).expect("query");
    assert_eq!(hits[0].path, "fresh.md");
    assert_eq!(hits[0].field, MatchField::Alias);

    // Rename re-keys and retitles.
    switcher.rename("fresh.md", "renamed-note.md");
    let hits = switcher.query("renamed note", 10, &never()).expect("query");
    assert_eq!(hits[0].path, "renamed-note.md");

    // Removal disappears.
    switcher.remove("renamed-note.md");
    let hits = switcher.query("newcomer", 10, &never()).expect("query");
    assert!(hits.is_empty(), "{hits:?}");
}

/// AC4: highlighted ranges land on char boundaries and select real text,
/// Unicode included.
#[test]
fn highlight_ranges_select_valid_text() {
    let setup = setup();
    let mut switcher = Switcher::from_metadata(&reader(&setup)).expect("build");

    for (query, expected_path) in [
        ("café", "café-métro.md"),
        ("metro", "café-métro.md"),
        ("défense", "café-métro.md"),
        ("meeting", "meeting.md"),
    ] {
        let hits = switcher.query(query, 10, &never()).expect("query");
        let hit = hits
            .iter()
            .find(|h| h.path == expected_path)
            .unwrap_or_else(|| panic!("{query} finds {expected_path}: {hits:?}"));
        assert!(!hit.ranges.is_empty(), "{query} has highlights");
        for range in &hit.ranges {
            assert!(hit.display.is_char_boundary(range.start));
            assert!(hit.display.is_char_boundary(range.end));
            assert!(range.start < range.end && range.end <= hit.display.len());
        }
        // The concatenated highlighted text covers the query's letters
        // (case/diacritic-insensitively).
        let highlighted: String = hit
            .ranges
            .iter()
            .map(|r| &hit.display[r.start..r.end])
            .collect();
        assert!(
            highlighted.chars().count() >= query.chars().filter(|c| !c.is_whitespace()).count(),
            "{query}: highlights {highlighted:?} cover the pattern"
        );
    }
}

/// AC5: a superseded query stops producing results; streaming batches flow
/// for live queries.
#[test]
fn superseded_queries_stop_and_streaming_flows() {
    let setup = setup();
    let mut switcher = Switcher::from_metadata(&reader(&setup)).expect("build");

    // Streaming: at least one interim batch reaches the sink.
    let mut batches = 0;
    let hits = switcher
        .query_streaming("me", 10, &never(), &mut |batch| {
            batches += 1;
            assert!(batch.len() <= 10);
        })
        .expect("stream");
    assert!(batches >= 1, "batches streamed");
    assert!(!hits.is_empty());

    // Cancellation: the poll fires on the first chunk and nothing is
    // produced.
    let polls = AtomicU32::new(0);
    let mut cancelled_batches = 0;
    let result = switcher.query_streaming(
        "me",
        10,
        &|| {
            polls.fetch_add(1, Ordering::Relaxed);
            true
        },
        &mut |_| cancelled_batches += 1,
    );
    assert!(matches!(
        result,
        Err(loam_core::search::SwitcherError::Cancelled)
    ));
    assert_eq!(cancelled_batches, 0, "no batches after supersession");
    assert!(polls.load(Ordering::Relaxed) >= 1);

    // The switcher remains usable afterwards.
    let hits = switcher.query("metrics", 10, &never()).expect("query");
    assert_eq!(hits[0].path, "projects/metrics.md");
}
