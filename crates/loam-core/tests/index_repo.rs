//! LOA-61: pooled index query repositories.
//!
//! Deliberately imports NOTHING from rusqlite (AC5): every setup and
//! assertion below runs through loam-core's public API only — this file
//! compiling is the boundary proof that no raw SQL or rusqlite type is
//! needed to use the repositories.

use std::path::PathBuf;

use loam_core::index::{AliasRow, IndexDb, IndexReader, QueryError, ReindexOutcome, Reindexer};
use loam_core::vault::{ChangeOrigin, EventKind, VaultEvent};

fn created(path: &str) -> VaultEvent {
    VaultEvent {
        path: path.to_string(),
        kind: EventKind::Created,
        origin: ChangeOrigin::External,
    }
}

/// Vault with cross-linking notes, aliases, tags, and properties.
fn seed() -> (tempfile::TempDir, tempfile::TempDir, PathBuf, Reindexer) {
    let vault = tempfile::tempdir().expect("vault");
    let out = tempfile::tempdir().expect("out");
    let db_path = out.path().join("index.db");
    let notes: [(&str, &str); 4] = [
        (
            "alpha.md",
            "---\ntitle: Alpha\naliases: [A, First]\nstatus: open\n---\n\n# Alpha\n\n[[beta]] and [[Gamma Note]] again [[beta|see beta]].\n\n#project/x #zeta\n",
        ),
        (
            "beta.md",
            "# Beta\n\nBack to [[alpha]] once. #project/x\n\n## Beta Details\n",
        ),
        (
            "gamma.md",
            "---\naliases: G\nstatus: done\n---\n\n# Gamma Note\n\n[[alpha]] and [[beta]].\n",
        ),
        ("delta.md", "# Delta\n\nNo links here. #zeta\n"),
    ];
    for (path, content) in notes {
        std::fs::write(vault.path().join(path), content).expect("note");
    }
    let root = vault.path().canonicalize().expect("canonical");
    let db = IndexDb::open(&db_path).expect("open");
    let mut reindexer = Reindexer::new(db, root);
    for (path, _) in notes {
        let outcome = reindexer.apply(&created(path)).expect("index");
        assert!(matches!(outcome, ReindexOutcome::Indexed { .. }));
    }
    (vault, out, db_path, reindexer)
}

/// AC2: backlinks come back grouped by source note, sources path-ordered,
/// mentions in source order.
#[test]
fn backlinks_group_by_source_note() {
    let (_vault, _out, db_path, reindexer) = seed();
    drop(reindexer);
    let reader = IndexReader::open(&db_path).expect("reader");

    let groups = reader.backlinks("beta").expect("backlinks");
    let sources: Vec<&str> = groups.iter().map(|g| g.source_path.as_str()).collect();
    assert_eq!(sources, ["alpha.md", "gamma.md"], "grouped, path-ordered");
    assert_eq!(
        groups[0].mentions.len(),
        2,
        "both alpha mentions in one group"
    );
    assert!(
        groups[0].mentions[0].start < groups[0].mentions[1].start,
        "mentions in source order"
    );
    // Case-insensitive note-name match.
    let upper = reader.backlinks("BETA").expect("backlinks");
    assert_eq!(upper.len(), groups.len());
}

/// AC3: every listing is deterministically ordered across repeated queries.
#[test]
fn listings_are_deterministically_ordered() {
    let (_vault, _out, db_path, reindexer) = seed();
    drop(reindexer);
    let reader = IndexReader::open(&db_path).expect("reader");

    let files: Vec<String> = reader
        .files_page(100, None)
        .expect("files")
        .into_iter()
        .map(|f| f.path)
        .collect();
    assert_eq!(files, ["alpha.md", "beta.md", "delta.md", "gamma.md"]);

    let aliases: Vec<(String, String)> = reader
        .aliases_page(100, None)
        .expect("aliases")
        .into_iter()
        .map(|a| (a.alias, a.path))
        .collect();
    assert_eq!(
        aliases,
        [
            ("A".to_string(), "alpha.md".to_string()),
            ("First".to_string(), "alpha.md".to_string()),
            ("G".to_string(), "gamma.md".to_string()),
        ]
    );

    let tags: Vec<(String, u64)> = reader
        .tags_list()
        .expect("tags")
        .into_iter()
        .map(|t| (t.name, t.count))
        .collect();
    assert_eq!(
        tags,
        [("project/x".to_string(), 2), ("zeta".to_string(), 2),]
    );

    let headings: Vec<String> = reader
        .headings_of("beta.md")
        .expect("headings")
        .into_iter()
        .map(|h| h.text)
        .collect();
    assert_eq!(headings, ["Beta", "Beta Details"]);

    let properties: Vec<String> = reader
        .properties_of("alpha.md")
        .expect("properties")
        .into_iter()
        .map(|p| p.key)
        .collect();
    assert_eq!(
        properties,
        ["title", "aliases", "status"],
        "frontmatter order"
    );
    let keys: Vec<String> = reader
        .property_keys()
        .expect("keys")
        .into_iter()
        .map(|k| k.name)
        .collect();
    assert_eq!(keys, ["aliases", "status", "title"]);

    // Repeat queries return identical results.
    let again: Vec<String> = reader
        .files_page(100, None)
        .expect("files")
        .into_iter()
        .map(|f| f.path)
        .collect();
    assert_eq!(files, again);
}

/// AC4: walking keyset pages with size 1 reproduces the full listing with no
/// duplicates and no skips — for files and for composite alias cursors.
#[test]
fn pagination_never_duplicates_or_skips() {
    let (_vault, _out, db_path, reindexer) = seed();
    drop(reindexer);
    let reader = IndexReader::open(&db_path).expect("reader");

    let full: Vec<String> = reader
        .files_page(100, None)
        .expect("files")
        .into_iter()
        .map(|f| f.path)
        .collect();
    let mut walked = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = reader.files_page(1, cursor.as_deref()).expect("page");
        match page.last() {
            Some(last) => {
                cursor = Some(last.path.clone());
                walked.extend(page.into_iter().map(|f| f.path));
            }
            None => break,
        }
    }
    assert_eq!(walked, full, "files: page-1 walk == full listing");

    let full_aliases = reader.aliases_page(100, None).expect("aliases");
    let mut walked: Vec<AliasRow> = Vec::new();
    let mut cursor: Option<AliasRow> = None;
    loop {
        let page = reader.aliases_page(1, cursor.as_ref()).expect("page");
        match page.last() {
            Some(last) => {
                cursor = Some(last.clone());
                walked.extend(page);
            }
            None => break,
        }
    }
    assert_eq!(walked, full_aliases, "aliases: composite-cursor walk");
}

/// AC1: readers run concurrently with the single writer and always see a
/// consistent snapshot (never an error, never a torn read).
#[test]
fn readers_run_concurrently_with_the_writer() {
    let (vault, _out, db_path, mut reindexer) = seed();
    let reader = std::sync::Arc::new(IndexReader::open(&db_path).expect("reader"));

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut readers = Vec::new();
    for _ in 0..3 {
        let reader = reader.clone();
        let stop = stop.clone();
        readers.push(std::thread::spawn(move || {
            let mut queries = 0u32;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let files = reader.files_page(100, None).expect("files during writes");
                assert!(!files.is_empty());
                let groups = reader.backlinks("beta").expect("backlinks during writes");
                for group in &groups {
                    assert!(!group.mentions.is_empty(), "no torn groups");
                }
                queries += 1;
            }
            queries
        }));
    }

    // Writer: keep mutating alpha.md through the reindexer.
    for round in 0..50 {
        let body = format!("# Alpha\n\nRound {round} link [[beta]].\n");
        std::fs::write(vault.path().join("alpha.md"), body).expect("write");
        let outcome = reindexer
            .apply(&VaultEvent {
                path: "alpha.md".into(),
                kind: EventKind::Modified,
                origin: ChangeOrigin::External,
            })
            .expect("apply");
        assert!(matches!(outcome, ReindexOutcome::Indexed { .. }));
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    for handle in readers {
        let queries = handle.join().expect("reader thread");
        assert!(queries > 0, "readers actually ran during writes");
    }
}

/// AC5 (runtime side): the error type is a stable, serializable core type.
/// (The compile-time side is this whole file: zero rusqlite imports.)
#[test]
fn errors_are_stable_core_types() {
    let missing = IndexReader::open(std::path::Path::new("/definitely/missing/index.db"));
    let error = missing.err().expect("unavailable");
    assert_eq!(error, QueryError::Unavailable);
    assert_eq!(
        serde_json::to_value(&error).expect("serializes"),
        serde_json::json!({ "error": "unavailable" })
    );

    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<IndexReader>();
}
