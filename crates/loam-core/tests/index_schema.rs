//! LOA-55: the disposable SQLite index schema (D5, §5.5).

use std::path::{Path, PathBuf};

use loam_core::index::{FileRecord, IndexDb, SCHEMA_VERSION, TABLES, read_versions};
use loam_core::parse::parse;
use loam_core::vault::{Confirmation, DeviceLayout, VaultIdentity};

fn corpus_sources() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/markdown");
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("readable") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "md") {
                let rel = path
                    .strip_prefix(&root)
                    .expect("under root")
                    .to_string_lossy()
                    .replace('\\', "/");
                let source = std::fs::read_to_string(&path)
                    .expect("source")
                    .replace("\r\n", "\n");
                out.push((rel, source));
            }
        }
    }
    out.sort();
    out
}

/// A vault + device layout pair with an index path resolved per §5.5.
fn index_path(vault: &Path, app_data: &Path) -> PathBuf {
    let identity = VaultIdentity::establish(vault, Confirmation::Confirmed)
        .expect("establish")
        .expect("created");
    DeviceLayout::new(app_data)
        .paths_for(identity.id, vault)
        .expect("layout")
        .index_db
}

fn record<'a>(path: &'a str, hash: &'a str) -> FileRecord<'a> {
    FileRecord {
        path,
        content_hash: hash,
        size: 1234,
        modified_ms: 1_752_000_000_000,
        indexed_ms: 1_752_000_000_500,
        size_policy: "full",
    }
}

fn import_corpus(db: &mut IndexDb) -> usize {
    let corpus = corpus_sources();
    let count = corpus.len();
    for (rel, source) in corpus {
        let doc = parse(&source);
        let hash = format!("hash-{rel}");
        db.replace_file(&record(&rel, &hash), &doc).expect("index");
    }
    count
}

fn dump(db_path: &Path) -> Vec<String> {
    let conn = rusqlite::Connection::open(db_path).expect("open");
    let mut out = Vec::new();
    for table in [
        "files",
        "headings",
        "links",
        "tags",
        "properties",
        "blocks",
        "aliases",
    ] {
        // Deterministic, id-free dump: ids are assigned in insert order and
        // are not part of the logical content.
        let sql = match table {
            "files" => "SELECT path, content_hash, size, modified_ms, size_policy \
                        FROM files ORDER BY path"
                .to_string(),
            "aliases" => "SELECT f.path, a.alias FROM aliases a \
                          JOIN files f ON f.id = a.file_id ORDER BY f.path, a.alias"
                .to_string(),
            other => format!(
                "SELECT f.path, t.start, t.end FROM {other} t \
                 JOIN files f ON f.id = t.file_id ORDER BY f.path, t.start, t.end"
            ),
        };
        let mut statement = conn.prepare(&sql).expect("prepare");
        let columns = statement.column_count();
        let rows = statement
            .query_map([], |row| {
                let mut fields = Vec::new();
                for index in 0..columns {
                    fields.push(
                        row.get::<_, rusqlite::types::Value>(index)
                            .map(|v| format!("{v:?}"))?,
                    );
                }
                Ok(format!("{table}: {}", fields.join(" | ")))
            })
            .expect("query");
        for row in rows {
            out.push(row.expect("row"));
        }
    }
    out
}

/// AC1: a fresh vault index contains every documented table and its indexes.
#[test]
fn fresh_index_creates_every_table_and_index() {
    let vault = tempfile::tempdir().expect("vault");
    let app_data = tempfile::tempdir().expect("app data");
    let path = index_path(vault.path(), app_data.path());
    let _db = IndexDb::open(&path).expect("open");

    let conn = rusqlite::Connection::open(&path).expect("open raw");
    let names = |kind: &str| -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = ?1 ORDER BY name")
            .expect("prepare");
        let rows = statement
            .query_map([kind], |r| r.get::<_, String>(0))
            .expect("query");
        rows.map(|r| r.expect("row"))
            .filter(|n| !n.starts_with("sqlite_"))
            .collect()
    };

    let tables = names("table");
    for table in TABLES {
        assert!(tables.contains(&table.to_string()), "missing table {table}");
    }
    let indexes = names("index");
    for index in [
        "idx_headings_file",
        "idx_headings_text",
        "idx_links_file",
        "idx_links_note",
        "idx_links_target",
        "idx_tags_file",
        "idx_tags_name",
        "idx_properties_file",
        "idx_properties_key",
        "idx_blocks_file",
        "idx_blocks_file_block",
        "idx_aliases_file",
        "idx_aliases_alias",
    ] {
        assert!(
            indexes.contains(&index.to_string()),
            "missing index {index}"
        );
    }
}

/// AC2: `index.db` is disposable — deleting it loses no user data, and a
/// rebuild reproduces the identical logical content.
#[test]
fn deleting_the_index_loses_nothing() {
    let vault = tempfile::tempdir().expect("vault");
    let app_data = tempfile::tempdir().expect("app data");
    std::fs::write(vault.path().join("note.md"), "# User data\n").expect("note");
    let path = index_path(vault.path(), app_data.path());

    let mut db = IndexDb::open(&path).expect("open");
    let imported = import_corpus(&mut db);
    assert!(imported >= 27, "corpus imported");
    drop(db);
    let first = dump(&path);
    assert!(!first.is_empty());

    // Delete the database (and WAL siblings) outright.
    for suffix in ["", "-wal", "-shm"] {
        let file = PathBuf::from(format!("{}{suffix}", path.display()));
        if file.exists() {
            std::fs::remove_file(file).expect("delete");
        }
    }

    // User data untouched; rebuild reproduces identical content.
    let note = std::fs::read_to_string(vault.path().join("note.md")).expect("note");
    assert_eq!(note, "# User data\n");
    let mut db = IndexDb::open(&path).expect("reopen");
    import_corpus(&mut db);
    drop(db);
    assert_eq!(dump(&path), first, "rebuild is deterministic and lossless");
}

/// AC3: the database path never resolves inside the vault, and opening the
/// index never writes into the vault.
#[test]
fn index_lives_outside_the_vault() {
    let vault = tempfile::tempdir().expect("vault");
    let app_data = tempfile::tempdir().expect("app data");
    let path = index_path(vault.path(), app_data.path());
    assert!(path.starts_with(app_data.path()));
    assert!(!path.starts_with(vault.path()));

    let _db = IndexDb::open(&path).expect("open");
    let loam_entries: Vec<_> = std::fs::read_dir(vault.path().join(".loam"))
        .expect("readable")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(loam_entries, ["vault.json"], "vault untouched by the index");
}

/// AC4: foreign-key and integrity checks pass after importing the whole
/// fixture corpus; cascade delete leaves no orphans.
#[test]
fn integrity_holds_after_fixture_imports() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("index.db");
    let mut db = IndexDb::open(&path).expect("open");
    import_corpus(&mut db);
    db.check_integrity().expect("clean integrity");

    // Re-import (idempotent replace) and re-check.
    import_corpus(&mut db);
    db.check_integrity().expect("still clean after replace");

    // Cascade: removing files must leave zero dependent rows.
    assert!(db.remove_file("links/wikilinks.md").expect("remove"));
    assert!(!db.remove_file("links/wikilinks.md").expect("gone"));
    db.check_integrity().expect("clean after delete");
    drop(db);
    let conn = rusqlite::Connection::open(&path).expect("open raw");
    let orphans: i64 = conn
        .query_row(
            "SELECT count(*) FROM links WHERE file_id NOT IN (SELECT id FROM files)",
            [],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(orphans, 0, "cascade removed dependents");
}

/// AC5: schema and parser versions are readable before any migration logic
/// exists or runs, via `user_version` + `meta`.
#[test]
fn version_metadata_is_readable_before_migrations() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("index.db");
    {
        let _db = IndexDb::open(&path).expect("create");
    }
    let versions = read_versions(&path).expect("read");
    assert_eq!(versions.schema, SCHEMA_VERSION);
    assert_eq!(versions.parser, Some(loam_core::parse::PARSER_VERSION));

    // A pre-schema (empty) database still reports its versions safely.
    let empty = dir.path().join("empty.db");
    rusqlite::Connection::open(&empty).expect("create empty");
    let versions = read_versions(&empty).expect("read empty");
    assert_eq!(versions.schema, 0);
    assert_eq!(versions.parser, None);
}
