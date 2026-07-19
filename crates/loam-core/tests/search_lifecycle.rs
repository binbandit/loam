//! LOA-67: the Tantivy index lifecycle (D6).

use std::path::PathBuf;

use loam_core::index::{IndexDb, ReindexOutcome, Reindexer};
use loam_core::search::{
    SEARCH_SCHEMA_VERSION, SearchIndex, SearchRebuildCause, rebuild_all, schema, search_doc,
};
use loam_core::vault::{
    ChangeOrigin, Confirmation, DeviceLayout, EventKind, VaultEvent, VaultIdentity,
};
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;

fn event(path: &str, kind: EventKind) -> VaultEvent {
    VaultEvent {
        path: path.to_string(),
        kind,
        origin: ChangeOrigin::External,
    }
}

struct Setup {
    _vault: tempfile::TempDir,
    _app_data: tempfile::TempDir,
    root: PathBuf,
    db_path: PathBuf,
    search_dir: PathBuf,
}

fn setup() -> Setup {
    let vault = tempfile::tempdir().expect("vault");
    let app_data = tempfile::tempdir().expect("app data");
    std::fs::create_dir_all(vault.path().join("area")).expect("mkdir");
    std::fs::write(
        vault.path().join("welcome.md"),
        "---\ntitle: ignored\nstatus: evergreen\n---\n\n# Welcome Note\n\n## Getting Started\n\nThe quick zebra reads markdown. #onboarding\n",
    )
    .expect("note");
    std::fs::write(
        vault.path().join("area/plans.md"),
        "# Quarterly Plans\n\nRoadmap gardening with [[welcome]]. #planning/q3\n",
    )
    .expect("note");

    let identity = VaultIdentity::establish(vault.path(), Confirmation::Confirmed)
        .expect("establish")
        .expect("created");
    let paths = DeviceLayout::new(app_data.path())
        .paths_for(identity.id, vault.path())
        .expect("layout");
    let root = vault.path().canonicalize().expect("canonical");

    // Populate the SQLite snapshot (E04) the search index feeds from.
    let db = IndexDb::open(&paths.index_db).expect("open db");
    let mut reindexer = Reindexer::new(db, root.clone());
    for path in ["welcome.md", "area/plans.md"] {
        let outcome = reindexer
            .apply(&event(path, EventKind::Created))
            .expect("index");
        assert!(matches!(outcome, ReindexOutcome::Indexed { .. }));
    }
    drop(reindexer);

    Setup {
        root,
        db_path: paths.index_db,
        search_dir: paths.search_dir,
        _vault: vault,
        _app_data: app_data,
    }
}

fn hits(search: &SearchIndex, field: &str, term: &str) -> Vec<String> {
    let index = search.tantivy();
    let schema = index.schema();
    let field = schema.get_field(field).expect("field");
    let path_field = schema.get_field("path").expect("path field");
    let reader = index.reader().expect("reader");
    let searcher = reader.searcher();
    let query = QueryParser::for_index(index, vec![field])
        .parse_query(term)
        .expect("query");
    let docs = searcher
        .search(&query, &TopDocs::with_limit(10).order_by_score())
        .expect("search");
    let mut out = Vec::new();
    for (_, address) in docs {
        let doc: tantivy::TantivyDocument = searcher.doc(address).expect("doc");
        use tantivy::schema::Value;
        out.push(
            doc.get_first(path_field)
                .and_then(|v| v.as_str())
                .expect("path value")
                .to_string(),
        );
    }
    out.sort();
    out
}

fn build(setup: &Setup) -> SearchIndex {
    let metadata = loam_core::index::IndexReader::open(&setup.db_path).expect("metadata");
    let (mut search, cause) = SearchIndex::open(&setup.search_dir).expect("open");
    assert_eq!(cause, Some(SearchRebuildCause::Missing));
    let fed = rebuild_all(&mut search, &metadata, &setup.root, |_| {}).expect("rebuild");
    assert_eq!(fed, 2);
    search
}

/// AC1: title, headings, body, path, tags, and properties are all queryable
/// after a full build.
#[test]
fn full_build_indexes_every_p0_field() {
    let setup = setup();
    let search = build(&setup);

    assert_eq!(hits(&search, "title", "welcome"), ["welcome.md"]);
    assert_eq!(hits(&search, "headings", "started"), ["welcome.md"]);
    assert_eq!(hits(&search, "body", "zebra"), ["welcome.md"]);
    assert_eq!(hits(&search, "path_text", "area"), ["area/plans.md"]);
    assert_eq!(hits(&search, "tags", "onboarding"), ["welcome.md"]);
    assert_eq!(hits(&search, "properties", "evergreen"), ["welcome.md"]);
    // Nested tag names stay filterable exactly via the raw field.
    assert_eq!(
        hits(&search, "tags_raw", "\"planning/q3\""),
        ["area/plans.md"]
    );
}

/// AC2: incremental update removes stale terms; rename re-keys; remove
/// drops the document.
#[test]
fn incremental_updates_remove_stale_terms() {
    let setup = setup();
    let mut search = build(&setup);
    let metadata = loam_core::index::IndexReader::open(&setup.db_path).expect("metadata");

    // Modify: zebra -> heron. Stale term must stop matching.
    std::fs::write(
        setup.root.join("welcome.md"),
        "# Welcome Note\n\nThe quick heron reads markdown.\n",
    )
    .expect("modify");
    let doc = search_doc(&metadata, &setup.root, "welcome.md").expect("doc");
    search.upsert(&doc).expect("upsert");
    search.commit().expect("commit");
    assert!(hits(&search, "body", "zebra").is_empty(), "stale term gone");
    assert_eq!(hits(&search, "body", "heron"), ["welcome.md"]);

    // Rename: document re-keyed, old path gone.
    std::fs::rename(
        setup.root.join("area/plans.md"),
        setup.root.join("area/goals.md"),
    )
    .expect("mv");
    let mut renamed = search_doc(&metadata, &setup.root, "area/plans.md").expect("doc");
    renamed.path = "area/goals.md".into();
    renamed.title = "goals".into();
    search.rename("area/plans.md", &renamed).expect("rename");
    search.commit().expect("commit");
    assert_eq!(
        search.indexed_paths().expect("paths"),
        ["area/goals.md", "welcome.md"]
    );

    // Remove: document deleted.
    search.remove("welcome.md").expect("remove");
    search.commit().expect("commit");
    assert_eq!(search.indexed_paths().expect("paths"), ["area/goals.md"]);
}

/// AC3: a schema-version bump triggers a safe rebuild (fresh, empty index).
#[test]
fn schema_version_change_triggers_rebuild() {
    let setup = setup();
    let search = build(&setup);
    assert_eq!(search.indexed_paths().expect("paths").len(), 2);
    drop(search);

    // Simulate an index written by an older schema.
    std::fs::write(setup.search_dir.join("schema-version"), "0\n").expect("age version");
    let (search, cause) = SearchIndex::open(&setup.search_dir).expect("reopen");
    assert_eq!(cause, Some(SearchRebuildCause::SchemaVersionChanged));
    assert!(
        search.indexed_paths().expect("paths").is_empty(),
        "fresh index awaiting rebuild"
    );
    assert_eq!(
        std::fs::read_to_string(setup.search_dir.join("schema-version"))
            .expect("version file")
            .trim()
            .parse::<u32>()
            .expect("number"),
        SEARCH_SCHEMA_VERSION
    );
}

/// AC4: a corrupt search index rebuilds without touching notes.
#[test]
fn corrupt_index_rebuilds_without_touching_notes() {
    let setup = setup();
    drop(build(&setup));

    // Corrupt every tantivy file.
    let tantivy_dir = setup.search_dir.join("tantivy");
    for entry in std::fs::read_dir(&tantivy_dir).expect("readable") {
        let path = entry.expect("entry").path();
        if path.is_file() {
            std::fs::write(&path, b"corrupt").expect("scribble");
        }
    }
    let note_before = std::fs::read(setup.root.join("welcome.md")).expect("note");

    let (mut search, cause) = SearchIndex::open(&setup.search_dir).expect("recover");
    assert_eq!(cause, Some(SearchRebuildCause::Corrupt));
    let metadata = loam_core::index::IndexReader::open(&setup.db_path).expect("metadata");
    let fed = rebuild_all(&mut search, &metadata, &setup.root, |_| {}).expect("rebuild");
    assert_eq!(fed, 2);
    assert_eq!(hits(&search, "body", "zebra"), ["welcome.md"]);

    let note_after = std::fs::read(setup.root.join("welcome.md")).expect("note");
    assert_eq!(note_before, note_after, "notes untouched by recovery");
}

/// AC5: everything lives under the per-device `search/` dir — the vault
/// contains no tantivy files.
#[test]
fn no_search_files_in_the_vault() {
    let setup = setup();
    let search = build(&setup);
    assert!(
        search
            .dir()
            .starts_with(setup.search_dir.parent().expect("device dir"))
    );

    let mut stack = vec![setup.root.clone()];
    let mut vault_files = Vec::new();
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("readable") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
            } else {
                vault_files.push(path);
            }
        }
    }
    for file in &vault_files {
        let name = file
            .file_name()
            .expect("name")
            .to_string_lossy()
            .into_owned();
        assert!(
            name.ends_with(".md") || name == "vault.json",
            "unexpected file in vault: {file:?}"
        );
    }
    // The schema builder itself stays single-sourced.
    assert_eq!(schema().fields().count(), 8, "v1 schema field count");
}
