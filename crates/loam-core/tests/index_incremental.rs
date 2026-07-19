//! LOA-59: transactional incremental reindexing.

use std::path::{Path, PathBuf};

use loam_core::index::{IndexDb, ReindexOutcome, Reindexer};
use loam_core::vault::{ChangeOrigin, EventKind, VaultEvent};

fn event(path: &str, kind: EventKind) -> VaultEvent {
    VaultEvent {
        path: path.to_string(),
        kind,
        origin: ChangeOrigin::External,
    }
}

fn setup() -> (tempfile::TempDir, tempfile::TempDir, Reindexer, PathBuf) {
    let vault = tempfile::tempdir().expect("vault");
    let out = tempfile::tempdir().expect("out");
    let db_path = out.path().join("index.db");
    let root = vault.path().canonicalize().expect("canonical");
    let db = IndexDb::open(&db_path).expect("open");
    let reindexer = Reindexer::new(db, root);
    (vault, out, reindexer, db_path)
}

fn counts(db_path: &Path, path: &str) -> (i64, i64, i64, i64, i64, i64) {
    let conn = rusqlite::Connection::open(db_path).expect("open");
    let count = |sql: &str| -> i64 { conn.query_row(sql, [path], |r| r.get(0)).expect("count") };
    (
        count("SELECT count(*) FROM links l JOIN files f ON f.id = l.file_id WHERE f.path = ?1"),
        count("SELECT count(*) FROM tags t JOIN files f ON f.id = t.file_id WHERE f.path = ?1"),
        count("SELECT count(*) FROM headings h JOIN files f ON f.id = h.file_id WHERE f.path = ?1"),
        count("SELECT count(*) FROM blocks b JOIN files f ON f.id = b.file_id WHERE f.path = ?1"),
        count(
            "SELECT count(*) FROM properties p JOIN files f ON f.id = p.file_id WHERE f.path = ?1",
        ),
        count("SELECT count(*) FROM aliases a JOIN files f ON f.id = a.file_id WHERE f.path = ?1"),
    )
}

const NOTE_V1: &str =
    "---\ntitle: Note\naliases: [N1]\n---\n\n# One\n\n[[Target A]] #alpha\n\npara ^b1\n";
const NOTE_V2: &str = "# Two\n\n[[Target B]] and [[Target C]]\n";

/// AC1: a create event adds one complete record set.
#[test]
fn create_adds_a_complete_record_set() {
    let (vault, _out, mut reindexer, db_path) = setup();
    std::fs::write(vault.path().join("note.md"), NOTE_V1).expect("note");

    let outcome = reindexer
        .apply(&event("note.md", EventKind::Created))
        .expect("apply");
    assert_eq!(
        outcome,
        ReindexOutcome::Indexed {
            path: "note.md".into()
        }
    );
    drop(reindexer);
    assert_eq!(counts(&db_path, "note.md"), (1, 1, 1, 1, 2, 1));
}

/// AC2: modify replaces everything — no stale rows of any kind survive.
#[test]
fn modify_leaves_no_stale_rows() {
    let (vault, _out, mut reindexer, db_path) = setup();
    std::fs::write(vault.path().join("note.md"), NOTE_V1).expect("note");
    reindexer
        .apply(&event("note.md", EventKind::Created))
        .expect("create");

    std::fs::write(vault.path().join("note.md"), NOTE_V2).expect("modify");
    let outcome = reindexer
        .apply(&event("note.md", EventKind::Modified))
        .expect("apply");
    assert_eq!(
        outcome,
        ReindexOutcome::Indexed {
            path: "note.md".into()
        }
    );
    drop(reindexer);

    // v2 has 2 links, no tags/blocks/properties/aliases, 1 heading.
    assert_eq!(counts(&db_path, "note.md"), (2, 0, 1, 0, 0, 0));
    let conn = rusqlite::Connection::open(&db_path).expect("open");
    let targets: Vec<String> = conn
        .prepare("SELECT target FROM links ORDER BY start")
        .expect("prepare")
        .query_map([], |r| r.get(0))
        .expect("query")
        .map(|r| r.expect("row"))
        .collect();
    assert_eq!(targets, ["Target B", "Target C"], "old link gone");
}

/// AC3: rename preserves identity (same rowid, dependents intact) while the
/// stored path updates.
#[test]
fn rename_preserves_identity() {
    let (vault, _out, mut reindexer, db_path) = setup();
    std::fs::write(vault.path().join("note.md"), NOTE_V1).expect("note");
    reindexer
        .apply(&event("note.md", EventKind::Created))
        .expect("create");

    let id_before: i64 = rusqlite::Connection::open(&db_path)
        .expect("open")
        .query_row("SELECT id FROM files WHERE path = 'note.md'", [], |r| {
            r.get(0)
        })
        .expect("id");

    std::fs::rename(vault.path().join("note.md"), vault.path().join("moved.md")).expect("mv");
    let outcome = reindexer
        .apply(&event(
            "moved.md",
            EventKind::Renamed {
                from: "note.md".into(),
            },
        ))
        .expect("apply");
    assert_eq!(
        outcome,
        ReindexOutcome::Renamed {
            from: "note.md".into(),
            to: "moved.md".into()
        }
    );
    drop(reindexer);

    let conn = rusqlite::Connection::open(&db_path).expect("open");
    let id_after: i64 = conn
        .query_row("SELECT id FROM files WHERE path = 'moved.md'", [], |r| {
            r.get(0)
        })
        .expect("id");
    assert_eq!(id_after, id_before, "row identity preserved");
    let old: i64 = conn
        .query_row(
            "SELECT count(*) FROM files WHERE path = 'note.md'",
            [],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(old, 0);
    drop(conn);
    assert_eq!(
        counts(&db_path, "moved.md"),
        (1, 1, 1, 1, 2, 1),
        "dependents untouched by rename"
    );
}

/// AC4: delete removes the file and every dependent row.
#[test]
fn delete_removes_all_dependents() {
    let (vault, _out, mut reindexer, db_path) = setup();
    std::fs::write(vault.path().join("note.md"), NOTE_V1).expect("note");
    reindexer
        .apply(&event("note.md", EventKind::Created))
        .expect("create");

    std::fs::remove_file(vault.path().join("note.md")).expect("rm");
    let outcome = reindexer
        .apply(&event("note.md", EventKind::Deleted))
        .expect("apply");
    assert_eq!(
        outcome,
        ReindexOutcome::Removed {
            path: "note.md".into()
        }
    );
    reindexer.db_mut().check_integrity().expect("clean");
    drop(reindexer);

    let conn = rusqlite::Connection::open(&db_path).expect("open");
    for table in [
        "files",
        "links",
        "tags",
        "headings",
        "blocks",
        "properties",
        "aliases",
    ] {
        let count: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 0, "{table} must be empty");
    }
}

/// AC5: repeated identical events (same content hash) deduplicate to no-ops
/// and the record set stays byte-identical.
#[test]
fn repeated_identical_events_are_idempotent() {
    let (vault, _out, mut reindexer, db_path) = setup();
    std::fs::write(vault.path().join("note.md"), NOTE_V1).expect("note");
    reindexer
        .apply(&event("note.md", EventKind::Created))
        .expect("create");

    for _ in 0..3 {
        let outcome = reindexer
            .apply(&event("note.md", EventKind::Modified))
            .expect("apply");
        assert_eq!(
            outcome,
            ReindexOutcome::Unchanged {
                path: "note.md".into()
            },
            "identical hash deduplicates"
        );
    }
    // Deleting twice is idempotent too.
    std::fs::remove_file(vault.path().join("note.md")).expect("rm");
    reindexer
        .apply(&event("note.md", EventKind::Deleted))
        .expect("first delete");
    let again = reindexer
        .apply(&event("note.md", EventKind::Deleted))
        .expect("second delete");
    assert_eq!(
        again,
        ReindexOutcome::Removed {
            path: "note.md".into()
        }
    );
    drop(reindexer);
    assert_eq!(counts(&db_path, "note.md"), (0, 0, 0, 0, 0, 0));
}

/// Scope guard: ignored paths, tempfiles, and non-Markdown stay out; a
/// rename out of `.md` removes the record; outcomes serialize stably.
#[test]
fn ineligible_paths_and_out_of_scope_renames() {
    let (vault, _out, mut reindexer, _db_path) = setup();
    for path in [".obsidian/x.md", "draft.loamtmp", "image.png"] {
        let outcome = reindexer
            .apply(&event(path, EventKind::Created))
            .expect("apply");
        assert_eq!(
            outcome,
            ReindexOutcome::Ineligible {
                path: path.to_string()
            }
        );
    }

    std::fs::write(vault.path().join("note.md"), NOTE_V1).expect("note");
    reindexer
        .apply(&event("note.md", EventKind::Created))
        .expect("create");
    std::fs::rename(vault.path().join("note.md"), vault.path().join("note.txt")).expect("mv");
    let outcome = reindexer
        .apply(&event(
            "note.txt",
            EventKind::Renamed {
                from: "note.md".into(),
            },
        ))
        .expect("apply");
    assert_eq!(
        outcome,
        ReindexOutcome::Removed {
            path: "note.md".into()
        }
    );

    let json = serde_json::to_value(&outcome).expect("serializes");
    assert_eq!(
        json,
        serde_json::json!({ "result": "removed", "path": "note.md" }),
        "stable camelCase result payloads"
    );
}
