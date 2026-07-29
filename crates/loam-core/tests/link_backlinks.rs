//! LOA-113: linked mentions with bounded context and exact jump ranges.

use std::fs;
use std::path::PathBuf;

use loam_core::links::{MAX_MENTIONS_PER_NOTE, MentionRef, mentions_with_context};

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Fixture {
    fn new(files: &[(&str, &str)]) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonical");
        for (path, content) in files {
            let full = root.join(path);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).expect("mkdir");
            }
            fs::write(full, content).expect("write");
        }
        Self { _dir: dir, root }
    }
}

fn mention(source: &str, content: &str, target: &str, occurrence: usize) -> MentionRef {
    let start = content
        .match_indices(target)
        .nth(occurrence)
        .expect("occurrence present")
        .0;
    MentionRef {
        source_path: source.to_string(),
        target: target.to_string(),
        start,
        end: start + target.len(),
    }
}

/// AC1/AC2: mentions group by source note, ordered by path then position.
#[test]
fn groups_are_deterministic_and_carry_context() {
    let alpha = "Intro line.\nSee [[Target]] mid-note.\nTrailing line.\n";
    let beta = "Only [[Target]] here.\n";
    let fixture = Fixture::new(&[("Zeta.md", beta), ("Alpha.md", alpha)]);

    let refs = vec![
        mention("Zeta.md", beta, "Target", 0),
        mention("Alpha.md", alpha, "Target", 0),
    ];
    let groups = mentions_with_context(&fixture.root, &refs);

    assert_eq!(
        groups
            .iter()
            .map(|g| g.source_path.as_str())
            .collect::<Vec<_>>(),
        vec!["Alpha.md", "Zeta.md"]
    );

    let first = &groups[0].mentions[0];
    assert_eq!(first.line, 2);
    // One line of context either side.
    assert_eq!(
        first.context,
        "Intro line.\nSee [[Target]] mid-note.\nTrailing line."
    );
    // The highlight range points at the target inside that context.
    assert_eq!(&first.context[first.match_start..first.match_end], "Target");
    // The jump range points at the target inside the source note.
    assert_eq!(&alpha[first.jump_start..first.jump_end], "Target");
    assert!(!groups[0].source_hash.is_empty());
}

/// AC4: every group carries the hash the snippets were read at.
#[test]
fn source_hash_changes_when_the_note_changes() {
    let body = "See [[Target]].\n";
    let fixture = Fixture::new(&[("A.md", body)]);
    let refs = vec![mention("A.md", body, "Target", 0)];

    let before = mentions_with_context(&fixture.root, &refs);
    fs::write(fixture.root.join("A.md"), "Changed. See [[Target]].\n").expect("rewrite");
    let after = mentions_with_context(&fixture.root, &refs);

    assert_ne!(before[0].source_hash, after[0].source_hash);
}

/// AC5: a stale range is dropped, not sliced at a boundary that moved.
#[test]
fn stale_ranges_are_dropped_without_failing_the_query() {
    let body = "See [[Target]].\n";
    let fixture = Fixture::new(&[("A.md", body), ("B.md", body)]);
    let refs = vec![
        MentionRef {
            source_path: "A.md".into(),
            target: "Target".into(),
            start: 9_000,
            end: 9_006,
        },
        mention("B.md", body, "Target", 0),
    ];

    let groups = mentions_with_context(&fixture.root, &refs);
    // A's mention is gone, but B still renders — one bad range must not
    // empty the panel.
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].source_path, "B.md");
}

/// Mentions per note are bounded, and the overflow is reported.
#[test]
fn mentions_per_note_are_capped() {
    let mut body = String::new();
    for index in 0..(MAX_MENTIONS_PER_NOTE + 10) {
        body.push_str(&format!("Line {index} mentions [[Target]].\n"));
    }
    let fixture = Fixture::new(&[("Busy.md", body.as_str())]);
    let refs: Vec<MentionRef> = (0..(MAX_MENTIONS_PER_NOTE + 10))
        .map(|index| mention("Busy.md", &body, "Target", index))
        .collect();

    let groups = mentions_with_context(&fixture.root, &refs);
    assert_eq!(groups[0].mentions.len(), MAX_MENTIONS_PER_NOTE);
    assert_eq!(groups[0].truncated, 10);
    // Still ordered by position.
    let lines: Vec<u32> = groups[0].mentions.iter().map(|m| m.line).collect();
    assert!(lines.windows(2).all(|pair| pair[0] < pair[1]));
}

/// A note that cannot be read is skipped, not fatal.
#[test]
fn unreadable_sources_are_skipped() {
    let body = "See [[Target]].\n";
    let fixture = Fixture::new(&[("Present.md", body)]);
    let refs = vec![
        MentionRef {
            source_path: "Missing.md".into(),
            target: "Target".into(),
            start: 0,
            end: 6,
        },
        mention("Present.md", body, "Target", 0),
    ];
    let groups = mentions_with_context(&fixture.root, &refs);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].source_path, "Present.md");
}

/// Context at the very start or end of a note stays in bounds.
#[test]
fn context_windows_clamp_at_note_edges() {
    let body = "[[Target]] on the first line.\n";
    let fixture = Fixture::new(&[("Edge.md", body)]);
    let refs = vec![mention("Edge.md", body, "Target", 0)];
    let groups = mentions_with_context(&fixture.root, &refs);
    let only = &groups[0].mentions[0];
    assert_eq!(only.line, 1);
    assert_eq!(only.context, "[[Target]] on the first line.");
    assert_eq!(&only.context[only.match_start..only.match_end], "Target");
}
