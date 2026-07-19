//! LOA-62: the §5.12 index determinism and integrity gate. Runs in the
//! regular workspace suite, so CI executes it on all three operating
//! systems. The fixture vault is the real `/fixtures/markdown/` corpus.

use std::path::{Path, PathBuf};

use loam_core::index::{IndexDb, Reindexer, logical_dump, rebuild_full};
use loam_core::vault::{ChangeOrigin, EventKind, VaultEvent};

/// Materialize the Markdown conformance corpus as a vault.
fn corpus_vault() -> tempfile::TempDir {
    let corpus = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/markdown");
    let vault = tempfile::tempdir().expect("vault");
    let mut stack = vec![corpus.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("readable") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "md") {
                let rel = path.strip_prefix(&corpus).expect("under corpus");
                let target = vault.path().join(rel);
                std::fs::create_dir_all(target.parent().expect("parent")).expect("mkdir");
                std::fs::copy(&path, &target).expect("copy");
            }
        }
    }
    vault
}

fn canonical(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().canonicalize().expect("canonical")
}

fn rebuild(root: &Path, db_path: &Path) -> Vec<String> {
    let report = rebuild_full(root, db_path, &mut |_| {}, &|| false).expect("rebuild");
    assert!(report.issues.is_empty(), "{:?}", report.issues);
    report.db.check_integrity().expect("integrity (AC3)");
    drop(report);
    logical_dump(db_path).expect("dump")
}

fn event(path: &str, kind: EventKind) -> VaultEvent {
    VaultEvent {
        path: path.to_string(),
        kind,
        origin: ChangeOrigin::External,
    }
}

/// AC1 + AC3: two full rebuilds of the fixture vault produce identical
/// normalized dumps, and every database passes integrity + FK checks.
#[test]
fn full_rebuilds_compare_equal() {
    let vault = corpus_vault();
    let root = canonical(&vault);
    let out = tempfile::tempdir().expect("out");

    let first = rebuild(&root, &out.path().join("a.db"));
    let second = rebuild(&root, &out.path().join("b.db"));
    assert!(!first.is_empty(), "corpus produced rows");
    assert_eq!(first, second, "full rebuilds are deterministic");
}

/// AC2 + AC3: replaying watcher events incrementally (creates, a modify, a
/// rename, a delete) reaches exactly the logical state of a clean rebuild
/// of the final vault.
#[test]
fn incremental_replay_matches_clean_rebuild() {
    let vault = corpus_vault();
    let root = canonical(&vault);
    let out = tempfile::tempdir().expect("out");

    // Incremental database: create everything, then mutate.
    let incremental_path = out.path().join("incremental.db");
    let db = IndexDb::open(&incremental_path).expect("open");
    let mut reindexer = Reindexer::new(db, root.clone());
    let mut files: Vec<String> = walk_md(&root);
    files.sort();
    for file in &files {
        reindexer
            .apply(&event(file, EventKind::Created))
            .expect("create");
    }
    // Mutations: modify one note, rename another, delete a third.
    std::fs::write(
        vault.path().join("core/escapes.md"),
        "# Rewritten\n\nNew [[Body]] with #fresh-tag.\n",
    )
    .expect("modify");
    reindexer
        .apply(&event("core/escapes.md", EventKind::Modified))
        .expect("modify");
    std::fs::rename(
        vault.path().join("links/wikilinks.md"),
        vault.path().join("links/renamed-wikilinks.md"),
    )
    .expect("rename");
    reindexer
        .apply(&event(
            "links/renamed-wikilinks.md",
            EventKind::Renamed {
                from: "links/wikilinks.md".into(),
            },
        ))
        .expect("rename");
    std::fs::remove_file(vault.path().join("gfm/table.md")).expect("delete");
    reindexer
        .apply(&event("gfm/table.md", EventKind::Deleted))
        .expect("delete");
    reindexer
        .db_mut()
        .check_integrity()
        .expect("integrity (AC3)");
    drop(reindexer);

    // Clean rebuild of the mutated vault must be logically identical.
    let clean = rebuild(&root, &out.path().join("clean.db"));
    let incremental = logical_dump(&incremental_path).expect("dump");
    assert_eq!(incremental, clean, "incremental replay == clean rebuild");
}

fn walk_md(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("readable") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "md") {
                out.push(
                    path.strip_prefix(root)
                        .expect("under root")
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    out
}

/// AC4: semantically equivalent event orders converge. Events over distinct
/// paths (plus duplicate modifies) are order-independent — every proptest
/// permutation must land on the same logical dump.
#[test]
fn equivalent_event_orders_converge() {
    let vault = corpus_vault();
    let root = canonical(&vault);
    let out = tempfile::tempdir().expect("out");

    let mut files = walk_md(&root);
    files.sort();
    // Baseline: sorted order.
    let baseline_path = out.path().join("baseline.db");
    {
        let db = IndexDb::open(&baseline_path).expect("open");
        let mut reindexer = Reindexer::new(db, root.clone());
        for file in &files {
            reindexer
                .apply(&event(file, EventKind::Created))
                .expect("create");
        }
    }
    let baseline = logical_dump(&baseline_path).expect("dump");

    proptest::proptest!(
        proptest::prelude::ProptestConfig { cases: 8, ..Default::default() },
        |(seed in proptest::prelude::any::<u64>())| {
            // Seeded Fisher–Yates permutation + duplicated events.
            let mut order: Vec<&String> = files.iter().collect();
            let mut state = seed | 1;
            for i in (1..order.len()).rev() {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                order.swap(i, (state >> 33) as usize % (i + 1));
            }

            let dir = tempfile::tempdir().expect("db dir");
            let path = dir.path().join("permuted.db");
            let db = IndexDb::open(&path).expect("open");
            let mut reindexer = Reindexer::new(db, root.clone());
            for file in &order {
                reindexer
                    .apply(&event(file, EventKind::Created))
                    .expect("create");
                // A duplicate event is semantically a no-op.
                if state.is_multiple_of(3) {
                    reindexer
                        .apply(&event(file, EventKind::Modified))
                        .expect("duplicate");
                }
            }
            reindexer.db_mut().check_integrity().expect("integrity");
            drop(reindexer);
            let dump = logical_dump(&path).expect("dump");
            proptest::prop_assert_eq!(&dump, &baseline, "permuted order converges");
        }
    );
}
