//! LOA-82: ranked search execution with snippets and paging.

use std::sync::atomic::{AtomicU32, Ordering};

use loam_core::search::{ExecuteError, SearchDoc, SearchIndex, SearchStatus};

fn doc(path: &str, title: &str, headings: &[&str], body: &str, tags: &[&str]) -> SearchDoc {
    SearchDoc {
        path: path.into(),
        title: title.into(),
        headings: headings.iter().map(|s| s.to_string()).collect(),
        body: body.into(),
        tags: tags.iter().map(|s| s.to_string()).collect(),
        properties: vec![],
    }
}

fn seeded(docs: &[SearchDoc]) -> (tempfile::TempDir, SearchIndex) {
    let dir = tempfile::tempdir().expect("dir");
    let (mut search, _) = SearchIndex::open(dir.path()).expect("open");
    for entry in docs {
        search.upsert(entry).expect("upsert");
    }
    search.commit().expect("commit");
    (dir, search)
}

fn never() -> impl Fn() -> bool {
    || false
}

/// AC1: a title match outranks equivalent heading-, body-, and tag-only
/// matches (D6 boosts).
#[test]
fn title_outranks_heading_body_and_tag_matches() {
    let (_dir, search) = seeded(&[
        doc(
            "tag-only.md",
            "Unrelated",
            &["Also unrelated"],
            "Nothing here.",
            &["quasar"],
        ),
        doc(
            "body-only.md",
            "Unrelated",
            &["Also unrelated"],
            "The quasar appears here.",
            &[],
        ),
        doc(
            "heading-only.md",
            "Unrelated",
            &["Quasar findings"],
            "Nothing here.",
            &[],
        ),
        doc(
            "title-only.md",
            "Quasar Notes",
            &["Also unrelated"],
            "Nothing here.",
            &[],
        ),
    ]);
    let page = search
        .handle()
        .search_page("quasar", 10, None, &never())
        .expect("search");
    let order: Vec<&str> = page.hits.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(
        order,
        [
            "title-only.md",
            "heading-only.md",
            "body-only.md",
            "tag-only.md"
        ],
        "boost order title > headings > body > tags"
    );
    assert_eq!(page.total, 4);
    assert_eq!(page.status, SearchStatus::Ready);
}

/// AC2: snippet ranges are char-boundary safe and slice to the matched text,
/// including case-insensitive and multi-byte content.
#[test]
fn snippets_carry_safe_source_ranges() {
    let (_dir, search) = seeded(&[doc(
        "note.md",
        "Note",
        &[],
        "Intro line without match.\nThe QUASAR shines — café quasar réunion.\nAnother quasar line.\nA fourth quasar line beyond the bound.\n",
        &[],
    )]);
    let page = search
        .handle()
        .search_page("quasar", 10, None, &never())
        .expect("search");
    let snippets = &page.hits[0].snippets;
    assert_eq!(snippets.len(), 3, "bounded line count");
    assert_eq!(
        snippets[0].line, 2,
        "1-based line numbers, non-matching skipped"
    );
    // Every range slices cleanly and matches the needle case-insensitively.
    for line in snippets {
        assert!(!line.ranges.is_empty());
        for range in &line.ranges {
            let slice = &line.text[range.start..range.end];
            assert_eq!(slice.to_lowercase(), "quasar", "range selects the term");
        }
    }
    assert_eq!(snippets[0].ranges.len(), 2, "both hits on the unicode line");
}

/// AC3: cursor paging walks the ranking with no duplicates or skips.
#[test]
fn paging_never_duplicates_or_skips() {
    let docs: Vec<SearchDoc> = (0..10)
        .map(|i| {
            doc(
                &format!("note-{i:02}.md"),
                &format!("Note {i:02}"),
                &[],
                "shared pulsar content",
                &[],
            )
        })
        .collect();
    let (_dir, search) = seeded(&docs);
    let handle = search.handle();

    let full = handle
        .search_page("pulsar", 200, None, &never())
        .expect("full");
    assert_eq!(full.total, 10);
    assert!(full.cursor.is_none(), "single page exhausts");
    let all: Vec<&str> = full.hits.iter().map(|h| h.path.as_str()).collect();

    let mut walked = Vec::new();
    let mut cursor = None;
    loop {
        let page = handle
            .search_page("pulsar", 3, cursor, &never())
            .expect("page");
        walked.extend(page.hits.iter().map(|h| h.path.clone()));
        match page.cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(
        walked.iter().map(String::as_str).collect::<Vec<_>>(),
        all,
        "page-3 walk reproduces the full ranking"
    );
}

/// AC4: cancelling a superseded request returns cleanly and the handle
/// remains fully usable.
#[test]
fn cancellation_leaves_the_reader_usable() {
    let docs: Vec<SearchDoc> = (0..20)
        .map(|i| doc(&format!("n{i}.md"), "T", &[], "meteor shower content", &[]))
        .collect();
    let (_dir, search) = seeded(&docs);
    let handle = search.handle();

    let polls = AtomicU32::new(0);
    let result = handle.search_page("meteor", 200, None, &|| {
        polls.fetch_add(1, Ordering::Relaxed) >= 2
    });
    assert!(matches!(result, Err(ExecuteError::Cancelled)));
    assert!(polls.load(Ordering::Relaxed) >= 2, "polled between phases");

    let after = handle
        .search_page("meteor", 200, None, &never())
        .expect("reader survives cancellation");
    assert_eq!(after.total, 20);
}

/// AC5: results state when the index is rebuilding, then recover to Ready.
#[test]
fn results_state_rebuilding_during_rebuild() {
    // A vault + sqlite snapshot to drive rebuild_all.
    let vault = tempfile::tempdir().expect("vault");
    std::fs::write(vault.path().join("a.md"), "# Alpha\n\ncomet body\n").expect("note");
    std::fs::write(vault.path().join("b.md"), "# Beta\n\ncomet body\n").expect("note");
    let root = vault.path().canonicalize().expect("canonical");
    let out = tempfile::tempdir().expect("out");
    let db_path = out.path().join("index.db");
    {
        let db = loam_core::index::IndexDb::open(&db_path).expect("db");
        let mut reindexer = loam_core::index::Reindexer::new(db, root.clone());
        for path in ["a.md", "b.md"] {
            reindexer
                .apply(&loam_core::vault::VaultEvent {
                    path: path.into(),
                    kind: loam_core::vault::EventKind::Created,
                    origin: loam_core::vault::ChangeOrigin::External,
                })
                .expect("index");
        }
    }
    let metadata = loam_core::index::IndexReader::open(&db_path).expect("metadata");

    let search_dir = out.path().join("search");
    std::fs::create_dir_all(&search_dir).expect("mkdir");
    let (mut search, _) = SearchIndex::open(&search_dir).expect("open");
    let handle = search.handle();
    assert_eq!(handle.status(), SearchStatus::Ready);

    let mut statuses = Vec::new();
    loam_core::search::rebuild_all(&mut search, &metadata, &root, |_| {
        // Search DURING the rebuild via the pre-cloned handle.
        let page = handle
            .search_page("comet", 10, None, &never())
            .expect("search during rebuild");
        statuses.push(page.status);
    })
    .expect("rebuild");

    assert!(
        statuses.iter().all(|s| *s == SearchStatus::Rebuilding),
        "mid-rebuild searches reported Rebuilding: {statuses:?}"
    );
    let after = handle
        .search_page("comet", 10, None, &never())
        .expect("search after");
    assert_eq!(after.status, SearchStatus::Ready);
    assert_eq!(after.total, 2, "rebuild landed");
}
