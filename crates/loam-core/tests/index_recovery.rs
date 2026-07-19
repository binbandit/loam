//! LOA-56: versioned index migrations and recovery (D5).

use std::path::Path;

use loam_core::index::{
    FileRecord, IndexDb, IndexProgress, OpenOutcome, RebuildSession, RecoveryCause, SCHEMA_VERSION,
    open_with_recovery, read_versions,
};
use loam_core::parse::parse;

fn seeded_index(path: &Path) -> IndexDb {
    let mut db = IndexDb::open(path).expect("open");
    let doc = parse("# Seed\n\nA [[Linked Note]] with #seed-tag.\n");
    db.replace_file(
        &FileRecord {
            path: "seed.md",
            content_hash: "seed-hash",
            size: 42,
            modified_ms: 1,
            indexed_ms: 2,
            size_policy: "full",
        },
        &doc,
    )
    .expect("seed");
    db
}

fn file_count(path: &Path) -> i64 {
    let conn = rusqlite::Connection::open(path).expect("open");
    conn.query_row("SELECT count(*) FROM files", [], |r| r.get(0))
        .expect("count")
}

/// AC1: every version fixture (pre-schema v0, current v1) reaches the
/// current schema through the migration chain.
#[test]
fn migration_fixtures_reach_current_schema() {
    let dir = tempfile::tempdir().expect("dir");

    // v0 fixture: an empty pre-schema database file.
    let v0 = dir.path().join("v0.db");
    drop(rusqlite::Connection::open(&v0).expect("create"));
    assert_eq!(read_versions(&v0).expect("versions").schema, 0);
    drop(IndexDb::open(&v0).expect("migrate v0"));
    assert_eq!(read_versions(&v0).expect("versions").schema, SCHEMA_VERSION);

    // Current fixture: opening again is a no-op that keeps data.
    let current = dir.path().join("current.db");
    drop(seeded_index(&current));
    drop(IndexDb::open(&current).expect("reopen current"));
    assert_eq!(
        read_versions(&current).expect("versions").schema,
        SCHEMA_VERSION
    );
    assert_eq!(file_count(&current), 1, "no data lost on reopen");
}

/// AC2: a parser-version change chooses rebuild — never stale reuse.
#[test]
fn parser_version_change_forces_rebuild() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("index.db");
    drop(seeded_index(&path));

    // Simulate an index written by an older parser.
    {
        let conn = rusqlite::Connection::open(&path).expect("open");
        conn.execute(
            "UPDATE meta SET value = '0' WHERE key = 'parser_version'",
            [],
        )
        .expect("age the parser version");
    }

    let outcome = open_with_recovery(&path).expect("recover");
    let OpenOutcome::RebuildRequired(_db, diagnostic) = outcome else {
        panic!("stale parser index must not be reused");
    };
    assert_eq!(
        diagnostic.cause,
        RecoveryCause::ParserVersionChanged {
            found: Some(0),
            expected: loam_core::parse::PARSER_VERSION,
        }
    );
    let quarantined = diagnostic.quarantined.expect("old index quarantined");
    assert!(quarantined.exists());
    assert_eq!(file_count(&path), 0, "fresh index is empty, not stale");
}

/// AC3: a corrupted database is quarantined and a fresh index created.
#[test]
fn corrupted_database_is_quarantined_and_rebuilt() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("index.db");
    std::fs::write(&path, b"SECRET-NOTE-CONTENT this is not a sqlite file").expect("garbage");

    let outcome = open_with_recovery(&path).expect("recover");
    let OpenOutcome::RebuildRequired(db, diagnostic) = outcome else {
        panic!("corrupt index must be rebuilt");
    };
    assert!(matches!(diagnostic.cause, RecoveryCause::Corruption { .. }));
    let quarantined = diagnostic.quarantined.expect("quarantined");
    assert!(quarantined.exists(), "bad bytes preserved for inspection");
    db.check_integrity().expect("fresh index is sound");
}

/// AC4: an interrupted rebuild replacement leaves the last valid index in
/// place, and the next session starts clean.
#[test]
fn interrupted_rebuild_preserves_last_valid_index() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("index.db");
    drop(seeded_index(&path));
    assert_eq!(file_count(&path), 1);

    // Rebuild whose commit is interrupted right before the atomic rename.
    let mut session = RebuildSession::begin(&path)
        .expect("begin")
        .with_pre_commit_hook(|| Err(std::io::Error::other("simulated crash before rename")));
    let doc = parse("# Rebuilt\n");
    session
        .db()
        .replace_file(
            &FileRecord {
                path: "rebuilt.md",
                content_hash: "new-hash",
                size: 10,
                modified_ms: 3,
                indexed_ms: 4,
                size_policy: "full",
            },
            &doc,
        )
        .expect("write into temp");
    assert!(session.commit().is_err(), "commit interrupted");

    // The live index is untouched by the failed rebuild.
    let conn = rusqlite::Connection::open(&path).expect("open");
    let seed: i64 = conn
        .query_row(
            "SELECT count(*) FROM files WHERE path = 'seed.md'",
            [],
            |r| r.get(0),
        )
        .expect("query");
    assert_eq!(seed, 1, "last valid index preserved");
    drop(conn);

    // Clean restart path: a new session clears the stale temp and succeeds.
    let mut session = RebuildSession::begin(&path).expect("restart");
    let temp_count: i64 = {
        let doc = parse("# Rebuilt\n");
        session
            .db()
            .replace_file(
                &FileRecord {
                    path: "rebuilt.md",
                    content_hash: "new-hash",
                    size: 10,
                    modified_ms: 3,
                    indexed_ms: 4,
                    size_policy: "full",
                },
                &doc,
            )
            .expect("write");
        1
    };
    let db = session.commit().expect("commit succeeds");
    drop(db);
    assert_eq!(file_count(&path), temp_count, "atomic replace landed");
    let conn = rusqlite::Connection::open(&path).expect("open");
    let rebuilt: i64 = conn
        .query_row(
            "SELECT count(*) FROM files WHERE path = 'rebuilt.md'",
            [],
            |r| r.get(0),
        )
        .expect("query");
    assert_eq!(rebuilt, 1);
}

/// AC5: diagnostics identify the cause, serialize stably, and never expose
/// note content.
#[test]
fn diagnostics_are_stable_and_redacted() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("index.db");
    // The "corrupt file" contains note-like content; the diagnostic must not.
    std::fs::write(&path, b"---\ntitle: SECRET-NOTE-CONTENT\n---\nSECRET BODY").expect("garbage");

    let outcome = open_with_recovery(&path).expect("recover");
    let OpenOutcome::RebuildRequired(_db, diagnostic) = outcome else {
        panic!("corrupt index must be rebuilt");
    };
    let json = serde_json::to_string(&diagnostic).expect("serializes");
    assert!(json.contains("\"cause\":\"corruption\""), "{json}");
    assert!(json.contains("detail"), "cause detail present: {json}");
    assert!(
        !json.contains("SECRET"),
        "diagnostics must never carry note content: {json}"
    );

    // Progress payload shape is stable (camelCase, done/total).
    let progress = serde_json::to_value(IndexProgress { done: 3, total: 9 }).expect("serializes");
    assert_eq!(progress, serde_json::json!({ "done": 3, "total": 9 }));
}
