//! LOA-92: deterministic frecency ranking.

use loam_core::index::{IndexDb, Reindexer};
use loam_core::search::{Frecency, HALF_LIFE_MS, MAX_BOOST, Switcher};
use loam_core::vault::{ChangeOrigin, EventKind, VaultEvent};

const NOW: i64 = 1_752_000_000_000;

fn never() -> impl Fn() -> bool {
    || false
}

fn store(dir: &tempfile::TempDir) -> Frecency {
    Frecency::load(&dir.path().join("frecency.json"))
}

/// AC1: repeated recent opens boost — and the boost is bounded.
#[test]
fn repeated_opens_boost_bounded() {
    let dir = tempfile::tempdir().expect("dir");
    let mut frecency = store(&dir);

    frecency.record_open("a.md", NOW);
    let single = frecency.boost("a.md", NOW);
    assert!(single > 0.0, "one open boosts");

    for i in 0..100 {
        frecency.record_open("a.md", NOW + i);
    }
    let saturated = frecency.boost("a.md", NOW + 100);
    assert!(saturated > single, "repeats increase the boost");
    assert!(
        saturated <= MAX_BOOST + f32::EPSILON,
        "boost saturates at MAX_BOOST: {saturated}"
    );
    assert_eq!(frecency.boost("other.md", NOW), 0.0, "no history, no boost");
}

/// AC2: a stronger exact textual match still beats an unrelated recent note.
#[test]
fn exact_match_beats_unrelated_recent() {
    let vault = tempfile::tempdir().expect("vault");
    let out = tempfile::tempdir().expect("out");
    std::fs::write(vault.path().join("meeting.md"), "# Meeting\n").expect("note");
    std::fs::write(vault.path().join("mango-recipes.md"), "# Mango Recipes\n").expect("note");
    let root = vault.path().canonicalize().expect("canonical");
    let db_path = out.path().join("index.db");
    {
        let db = IndexDb::open(&db_path).expect("db");
        let mut reindexer = Reindexer::new(db, root);
        for path in ["meeting.md", "mango-recipes.md"] {
            reindexer
                .apply(&VaultEvent {
                    path: path.into(),
                    kind: EventKind::Created,
                    origin: ChangeOrigin::External,
                })
                .expect("index");
        }
    }
    let metadata = loam_core::index::IndexReader::open(&db_path).expect("metadata");
    let mut switcher = Switcher::from_metadata(&metadata).expect("build");

    // mango-recipes is opened constantly; meeting never.
    let mut frecency = store(&out);
    for i in 0..50 {
        frecency.record_open("mango-recipes.md", NOW - i * 1000);
    }

    let hits = switcher
        .query_with_frecency(&frecency, NOW, "meeting", 10, &never())
        .expect("query");
    assert_eq!(
        hits[0].path, "meeting.md",
        "exact title beats boosted fuzzy: {hits:?}"
    );
}

/// AC3: decay is a pure function of controlled time.
#[test]
fn decay_is_deterministic_over_fake_time() {
    let dir = tempfile::tempdir().expect("dir");
    let mut frecency = store(&dir);
    frecency.record_open("a.md", NOW);

    let fresh = frecency.boost("a.md", NOW);
    let one_half_life = frecency.boost("a.md", NOW + HALF_LIFE_MS);
    let two_half_lives = frecency.boost("a.md", NOW + 2 * HALF_LIFE_MS);

    assert!(
        (one_half_life - fresh / 2.0).abs() < 1e-4,
        "half-life halves"
    );
    assert!(
        (two_half_lives - fresh / 4.0).abs() < 1e-4,
        "two half-lives quarter"
    );
    // Same inputs, same outputs — repeated evaluation identical.
    assert_eq!(frecency.boost("a.md", NOW + HALF_LIFE_MS), one_half_life);
}

/// AC4: rename preserves history; delete removes stale entries. Both survive
/// a persistence round-trip.
#[test]
fn rename_preserves_and_delete_removes() {
    let dir = tempfile::tempdir().expect("dir");
    let mut frecency = store(&dir);
    frecency.record_open("old.md", NOW);
    frecency.record_open("gone.md", NOW);

    frecency.rename("old.md", "new.md");
    assert_eq!(frecency.boost("old.md", NOW), 0.0);
    assert!(frecency.boost("new.md", NOW) > 0.0, "history moved");

    frecency.remove("gone.md");
    assert_eq!(frecency.boost("gone.md", NOW), 0.0);

    frecency.save().expect("save");
    let reloaded = store(&dir);
    assert_eq!(reloaded.len(), 1);
    assert!(reloaded.boost("new.md", NOW) > 0.0, "round-trips");
}

/// AC5: the empty query returns recents in deterministic order.
#[test]
fn empty_query_returns_deterministic_recents() {
    let vault = tempfile::tempdir().expect("vault");
    let out = tempfile::tempdir().expect("out");
    for name in ["a.md", "b.md", "c.md", "d.md"] {
        std::fs::write(vault.path().join(name), format!("# {name}\n")).expect("note");
    }
    let root = vault.path().canonicalize().expect("canonical");
    let db_path = out.path().join("index.db");
    {
        let db = IndexDb::open(&db_path).expect("db");
        let mut reindexer = Reindexer::new(db, root);
        for name in ["a.md", "b.md", "c.md", "d.md"] {
            reindexer
                .apply(&VaultEvent {
                    path: name.into(),
                    kind: EventKind::Created,
                    origin: ChangeOrigin::External,
                })
                .expect("index");
        }
    }
    let metadata = loam_core::index::IndexReader::open(&db_path).expect("metadata");
    let mut switcher = Switcher::from_metadata(&metadata).expect("build");

    let mut frecency = store(&out);
    // c: heaviest; b: recent single; a: old single.
    for i in 0..5 {
        frecency.record_open("c.md", NOW - i);
    }
    frecency.record_open("b.md", NOW - 1000);
    frecency.record_open("a.md", NOW - HALF_LIFE_MS);

    let first = switcher
        .query_with_frecency(&frecency, NOW, "", 10, &never())
        .expect("query");
    let order: Vec<&str> = first.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(
        order,
        ["c.md", "b.md", "a.md", "d.md"],
        "recents by decayed weight, then the rest by title"
    );

    // Deterministic: identical on repeat.
    let second = switcher
        .query_with_frecency(&frecency, NOW, "", 10, &never())
        .expect("query");
    assert_eq!(first, second);
}
