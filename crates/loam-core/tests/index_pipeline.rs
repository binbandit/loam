//! LOA-58: the deterministic full-index pipeline.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use loam_core::index::{IndexProgress, RebuildError, rebuild_full};
use loam_core::vault::note_read;

fn build_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("vault");
    let root = dir.path();
    std::fs::create_dir_all(root.join("projects")).expect("mkdir");
    std::fs::create_dir_all(root.join(".obsidian")).expect("mkdir");
    std::fs::write(
        root.join("home.md"),
        "---\ntitle: Home\ntags: [start]\n---\n\n# Home\n\nSee [[projects/Plan]] and #welcome.\n",
    )
    .expect("note");
    std::fs::write(
        root.join("projects/plan.md"),
        "# Plan\n\n- [ ] task one ^t1\n\nBack to [[Home|the start]].\n",
    )
    .expect("note");
    std::fs::write(
        root.join("café.md"),
        "# Café ☕\n\n==highlight== %%hidden%%\n",
    )
    .expect("note");
    std::fs::write(root.join("attachment.png"), b"\x89PNG not markdown").expect("attachment");
    // Ignored directory content must not be indexed.
    std::fs::write(root.join(".obsidian/skip.md"), "# Skipped\n").expect("ignored");
    dir
}

fn canonical(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().canonicalize().expect("canonical")
}

fn dump(db_path: &Path) -> Vec<String> {
    let conn = rusqlite::Connection::open(db_path).expect("open");
    let mut out = Vec::new();
    for (table, sql) in [
        (
            "files",
            "SELECT path, content_hash, size, size_policy FROM files ORDER BY path".to_string(),
        ),
        (
            "links",
            "SELECT f.path, l.target, l.start, l.end FROM links l \
             JOIN files f ON f.id = l.file_id ORDER BY f.path, l.start"
                .to_string(),
        ),
        (
            "tags",
            "SELECT f.path, t.name, t.start FROM tags t \
             JOIN files f ON f.id = t.file_id ORDER BY f.path, t.start"
                .to_string(),
        ),
        (
            "headings",
            "SELECT f.path, h.level, h.text FROM headings h \
             JOIN files f ON f.id = h.file_id ORDER BY f.path, h.start"
                .to_string(),
        ),
        (
            "blocks",
            "SELECT f.path, b.block_id FROM blocks b \
             JOIN files f ON f.id = b.file_id ORDER BY f.path, b.block_id"
                .to_string(),
        ),
        (
            "properties",
            "SELECT f.path, p.key, p.value_type FROM properties p \
             JOIN files f ON f.id = p.file_id ORDER BY f.path, p.key"
                .to_string(),
        ),
    ] {
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

/// AC1 (+ scope): the same vault rebuilt twice — into two different index
/// files — produces logically identical rows, ignored dirs excluded.
#[test]
fn rebuild_is_deterministic() {
    let vault = build_vault();
    let root = canonical(&vault);
    let out = tempfile::tempdir().expect("out");

    let mut runs = Vec::new();
    for name in ["a.db", "b.db"] {
        let path = out.path().join(name);
        let report = rebuild_full(&root, &path, &mut |_| {}, &|| false).expect("rebuild");
        assert_eq!(
            report.total, 3,
            "three eligible notes (ignored dir skipped)"
        );
        assert_eq!(report.indexed, 3);
        assert!(report.issues.is_empty(), "{:?}", report.issues);
        drop(report);
        runs.push(dump(&path));
    }
    assert_eq!(runs[0], runs[1], "logically identical rows");
    assert!(
        !runs[0].iter().any(|row| row.contains("skip")),
        "ignored directories are not indexed: {:?}",
        runs[0]
    );
}

/// AC2: progress is monotonic, starts at 0, and ends exactly at total.
#[test]
fn progress_is_monotonic_to_total() {
    let vault = build_vault();
    let root = canonical(&vault);
    let out = tempfile::tempdir().expect("out");

    let mut updates: Vec<IndexProgress> = Vec::new();
    rebuild_full(
        &root,
        &out.path().join("index.db"),
        &mut |p| updates.push(p),
        &|| false,
    )
    .expect("rebuild");

    assert_eq!(updates.first(), Some(&IndexProgress { done: 0, total: 3 }));
    assert_eq!(updates.last(), Some(&IndexProgress { done: 3, total: 3 }));
    assert!(
        updates.windows(2).all(|w| w[0].done <= w[1].done),
        "monotonic: {updates:?}"
    );
    assert!(updates.iter().all(|p| p.total == 3));
}

/// AC3: an unreadable (non-UTF-8) note records a diagnostic and does not
/// abort unrelated files.
#[test]
fn bad_file_records_issue_without_aborting() {
    let vault = build_vault();
    std::fs::write(vault.path().join("binary.md"), [0xff, 0xfe, 0x00, 0x42]).expect("bad note");
    let root = canonical(&vault);
    let out = tempfile::tempdir().expect("out");
    let path = out.path().join("index.db");

    let report = rebuild_full(&root, &path, &mut |_| {}, &|| false).expect("rebuild");
    assert_eq!(report.total, 4);
    assert_eq!(report.indexed, 3, "unrelated files still indexed");
    assert_eq!(report.issues.len(), 1);
    assert_eq!(report.issues[0].path, "binary.md");
    assert_eq!(report.issues[0].detail, "not valid UTF-8");
    drop(report);
    let rows = dump(&path);
    assert!(rows.iter().any(|r| r.contains("home.md")));
    assert!(!rows.iter().any(|r| r.contains("binary.md")));
}

/// AC4: cancelling mid-rebuild leaves the previous index fully intact, and a
/// restart succeeds cleanly.
#[test]
fn cancel_never_exposes_a_half_valid_index() {
    let vault = build_vault();
    let root = canonical(&vault);
    let out = tempfile::tempdir().expect("out");
    let path = out.path().join("index.db");

    rebuild_full(&root, &path, &mut |_| {}, &|| false).expect("first rebuild");
    let before = dump(&path);

    // Add a note, then cancel the re-index after the first file.
    std::fs::write(vault.path().join("zz-new.md"), "# New\n").expect("note");
    let seen = AtomicU64::new(0);
    let result = rebuild_full(&root, &path, &mut |_| {}, &|| {
        seen.fetch_add(1, Ordering::SeqCst) >= 2
    });
    assert!(matches!(result, Err(RebuildError::Cancelled)));
    assert_eq!(dump(&path), before, "live index untouched by the cancel");

    // Clean restart picks up the new note.
    let report = rebuild_full(&root, &path, &mut |_| {}, &|| false).expect("restart");
    assert_eq!(report.total, 4);
    drop(report);
    assert!(dump(&path).iter().any(|r| r.contains("zz-new.md")));
}

/// AC5: note reads keep working while a rebuild is in flight — probed from
/// inside the progress callback, mid-pipeline.
#[test]
fn note_reads_stay_available_during_rebuild() {
    let vault = build_vault();
    let root = canonical(&vault);
    let out = tempfile::tempdir().expect("out");

    let mut probes = 0;
    rebuild_full(
        &root,
        &out.path().join("index.db"),
        &mut |p| {
            if p.done < p.total {
                let note = note_read(&root, "home.md").expect("note readable mid-rebuild");
                assert!(note.content.expect("content").contains("# Home"));
                probes += 1;
            }
        },
        &|| false,
    )
    .expect("rebuild");
    assert!(probes >= 3, "probed during the rebuild, not just after");
}
