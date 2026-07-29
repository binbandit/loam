//! LOA-106/LOA-109: rename as refactor — planning and atomic application.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use loam_core::links::{
    ApplyError, InboundLink, LinkFormat, PlanProblem, RenamePlan, VaultEntry, apply_rename,
    plan_rename,
};
use loam_core::parse::{LinkStyle, SourceRange};
use loam_core::vault::{EventSink, FileChanged};

/// Collects nothing: these tests assert on files, not events.
struct Silent;
impl EventSink for Silent {
    fn file_changed(&self, _event: FileChanged) {}
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Fixture {
    /// Builds a vault from `(path, content)` pairs.
    fn new(files: &[(&str, &str)]) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonical root");
        for (path, content) in files {
            let full = root.join(path);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).expect("mkdir");
            }
            fs::write(&full, content).expect("write fixture");
        }
        Self { _dir: dir, root }
    }

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.root.join(path)).expect("read")
    }

    fn exists(&self, path: &str) -> bool {
        self.root.join(path).exists()
    }

    fn root(&self) -> &Path {
        &self.root
    }
}

/// Finds `target` in `content` and returns the link occurrence for it.
fn link_at(source: &str, content: &str, target: &str, style: LinkStyle) -> InboundLink {
    let start = content.find(target).expect("target present in fixture");
    InboundLink {
        source_path: source.to_string(),
        target: target.to_string(),
        range: SourceRange {
            start,
            end: start + target.len(),
        },
        style,
    }
}

fn vault_of(paths: &[&str]) -> Vec<VaultEntry> {
    paths
        .iter()
        .map(|path| VaultEntry::new(*path, Vec::<String>::new()))
        .collect()
}

/// AC1 (LOA-106): every inbound link is found and rewritten, with previews.
#[test]
fn plans_rewrites_for_every_inbound_link() {
    let note = "See [[Old Note]] and [[Old Note#Goals]] here.\n";
    let other = "Another [[Old Note|alias text]] mention.\n";
    let fixture = Fixture::new(&[
        ("Old Note.md", "# Old\n"),
        ("Daily/Today.md", note),
        ("Projects/Plan.md", other),
    ]);
    let inbound = vec![
        link_at("Daily/Today.md", note, "Old Note", LinkStyle::Wiki),
        link_at("Daily/Today.md", note, "Old Note#Goals", LinkStyle::Wiki),
        link_at("Projects/Plan.md", other, "Old Note", LinkStyle::Wiki),
    ];
    let vault = vault_of(&["Old Note.md", "Daily/Today.md", "Projects/Plan.md"]);

    let plan = plan_rename(
        fixture.root(),
        "Old Note.md",
        "New Note.md",
        &inbound,
        &vault,
        LinkFormat::ShortestUnique,
    );

    assert_eq!(plan.file_count(), 2);
    assert_eq!(plan.link_count, 3);
    assert!(!plan.is_blocked());
    // Deterministic file order for the preview list.
    assert_eq!(
        plan.files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        vec!["Daily/Today.md", "Projects/Plan.md"]
    );
    // Fragments survive the rewrite.
    let edits: Vec<&str> = plan.files[0]
        .edits
        .iter()
        .map(|e| e.after.as_str())
        .collect();
    assert_eq!(edits, vec!["New Note", "New Note#Goals"]);
    // Previews carry the whole line, before and after.
    let preview = &plan.files[0].previews[0];
    assert_eq!(preview.line, 1);
    assert!(preview.before.contains("[[Old Note]]"));
    assert!(preview.after.contains("[[New Note]]"));
}

/// AC2 (LOA-106): each link format spells the new target its own way.
#[test]
fn link_format_policies_are_honoured() {
    let note = "Link to [[Loam]] here.\n";
    let fixture = Fixture::new(&[
        ("Projects/Loam.md", "# Loam\n"),
        ("Daily/Today.md", note),
        ("Other/Loam.md", "# Other Loam\n"),
    ]);
    let inbound = vec![link_at("Daily/Today.md", note, "Loam", LinkStyle::Wiki)];
    let vault = vault_of(&["Projects/Loam.md", "Daily/Today.md", "Other/Loam.md"]);

    let shortest = plan_rename(
        fixture.root(),
        "Projects/Loam.md",
        "Archive/Loam.md",
        &inbound,
        &vault,
        LinkFormat::ShortestUnique,
    );
    // The name is NOT unique (Other/Loam.md exists), so the path is kept.
    assert_eq!(shortest.files[0].edits[0].after, "Archive/Loam");

    let absolute = plan_rename(
        fixture.root(),
        "Projects/Loam.md",
        "Archive/Loam.md",
        &inbound,
        &vault,
        LinkFormat::AbsoluteInVault,
    );
    assert_eq!(absolute.files[0].edits[0].after, "Archive/Loam");

    let relative = plan_rename(
        fixture.root(),
        "Projects/Loam.md",
        "Archive/Loam.md",
        &inbound,
        &vault,
        LinkFormat::Relative,
    );
    assert_eq!(relative.files[0].edits[0].after, "../Archive/Loam");
}

/// AC2: a unique name shortens; the extension is preserved when written.
#[test]
fn shortest_unique_shortens_and_keeps_extension_style() {
    let note = "A [[Projects/Loam]] and a [markdown](Projects/Loam.md).\n";
    let fixture = Fixture::new(&[("Projects/Loam.md", "# Loam\n"), ("Note.md", note)]);
    let inbound = vec![
        link_at("Note.md", note, "Projects/Loam", LinkStyle::Wiki),
        link_at("Note.md", note, "Projects/Loam.md", LinkStyle::Markdown),
    ];
    let vault = vault_of(&["Projects/Loam.md", "Note.md"]);

    let plan = plan_rename(
        fixture.root(),
        "Projects/Loam.md",
        "Archive/Renamed.md",
        &inbound,
        &vault,
        LinkFormat::ShortestUnique,
    );
    let after: Vec<&str> = plan.files[0]
        .edits
        .iter()
        .map(|e| e.after.as_str())
        .collect();
    // The wikilink loses the extension it never had; the Markdown link keeps
    // the one it did — each link stays spelled the way it was written.
    assert_eq!(after, vec!["Renamed", "Renamed.md"]);
}

/// AC4 (LOA-106): collisions and stale sources block the plan.
#[test]
fn collisions_and_stale_sources_are_reported() {
    let note = "Link [[Old]] here.\n";
    let fixture = Fixture::new(&[
        ("Old.md", "# Old\n"),
        ("Taken.md", "# Taken\n"),
        ("Note.md", note),
    ]);
    let vault = vault_of(&["Old.md", "Taken.md", "Note.md"]);
    let inbound = vec![link_at("Note.md", note, "Old", LinkStyle::Wiki)];

    let collision = plan_rename(
        fixture.root(),
        "Old.md",
        "Taken.md",
        &inbound,
        &vault,
        LinkFormat::ShortestUnique,
    );
    assert!(collision.is_blocked());
    assert_eq!(
        collision.problems,
        vec![PlanProblem::Collision {
            path: "Taken.md".into()
        }]
    );

    // An index entry pointing at a range that no longer holds that text.
    let stale = InboundLink {
        source_path: "Note.md".into(),
        target: "Old".into(),
        range: SourceRange { start: 0, end: 3 },
        style: LinkStyle::Wiki,
    };
    let plan = plan_rename(
        fixture.root(),
        "Old.md",
        "New.md",
        &[stale],
        &vault,
        LinkFormat::ShortestUnique,
    );
    assert_eq!(
        plan.problems,
        vec![PlanProblem::StaleSource {
            path: "Note.md".into()
        }]
    );
}

/// §3.4: more than 20 affected files requires explicit confirmation.
#[test]
fn large_renames_require_confirmation() {
    let mut files: Vec<(String, String)> = vec![("Old.md".into(), "# Old\n".into())];
    for index in 0..25 {
        files.push((format!("Note{index}.md"), "See [[Old]].\n".to_string()));
    }
    let borrowed: Vec<(&str, &str)> = files
        .iter()
        .map(|(path, content)| (path.as_str(), content.as_str()))
        .collect();
    let fixture = Fixture::new(&borrowed);
    let paths: Vec<&str> = borrowed.iter().map(|(path, _)| *path).collect();
    let vault = vault_of(&paths);
    let inbound: Vec<InboundLink> = (0..25)
        .map(|index| {
            link_at(
                &format!("Note{index}.md"),
                "See [[Old]].\n",
                "Old",
                LinkStyle::Wiki,
            )
        })
        .collect();

    let plan = plan_rename(
        fixture.root(),
        "Old.md",
        "New.md",
        &inbound,
        &vault,
        LinkFormat::ShortestUnique,
    );
    assert_eq!(plan.file_count(), 25);
    assert!(plan.needs_confirmation());

    let small = RenamePlan {
        files: plan.files[..3].to_vec(),
        ..plan.clone()
    };
    assert!(!small.needs_confirmation());
}

/// AC1/AC2 (LOA-109): every file is rewritten and the note moves last.
#[test]
fn apply_rewrites_links_then_moves_the_note() {
    let a = "See [[Old]] twice: [[Old#Goals]].\n";
    let b = "And [[Old]] again.\n";
    let fixture = Fixture::new(&[("Old.md", "# Old\n"), ("A.md", a), ("B.md", b)]);
    let vault = vault_of(&["Old.md", "A.md", "B.md"]);
    let inbound = vec![
        link_at("A.md", a, "Old", LinkStyle::Wiki),
        link_at("A.md", a, "Old#Goals", LinkStyle::Wiki),
        link_at("B.md", b, "Old", LinkStyle::Wiki),
    ];
    let plan = plan_rename(
        fixture.root(),
        "Old.md",
        "New.md",
        &inbound,
        &vault,
        LinkFormat::ShortestUnique,
    );

    let report = apply_rename(fixture.root(), &plan, &Silent, &|| false).expect("apply");
    assert_eq!(report.changed_files, vec!["A.md", "B.md"]);
    assert_eq!(report.changed_links, 3);
    assert!(report.renamed);
    assert!(report.failed.is_empty());
    assert!(report.skipped.is_empty());

    assert_eq!(fixture.read("A.md"), "See [[New]] twice: [[New#Goals]].\n");
    assert_eq!(fixture.read("B.md"), "And [[New]] again.\n");
    assert!(fixture.exists("New.md"));
    assert!(!fixture.exists("Old.md"));
}

/// AC4 (LOA-109): cancellation stops between files and says what remains.
#[test]
fn cancellation_is_explicit_and_leaves_the_note_in_place() {
    let a = "See [[Old]].\n";
    let b = "Also [[Old]].\n";
    let fixture = Fixture::new(&[("Old.md", "# Old\n"), ("A.md", a), ("B.md", b)]);
    let vault = vault_of(&["Old.md", "A.md", "B.md"]);
    let inbound = vec![
        link_at("A.md", a, "Old", LinkStyle::Wiki),
        link_at("B.md", b, "Old", LinkStyle::Wiki),
    ];
    let plan = plan_rename(
        fixture.root(),
        "Old.md",
        "New.md",
        &inbound,
        &vault,
        LinkFormat::ShortestUnique,
    );

    // Cancel after the first file has been written.
    let seen = AtomicBool::new(false);
    let report = apply_rename(fixture.root(), &plan, &Silent, &|| {
        if seen.swap(true, Ordering::SeqCst) {
            return true;
        }
        false
    })
    .expect("apply");

    assert!(report.cancelled);
    assert_eq!(report.changed_files, vec!["A.md"]);
    assert_eq!(report.remaining, vec!["B.md"]);
    // The note stays put, so the links that were not rewritten still resolve.
    assert!(fixture.exists("Old.md"));
    assert!(!fixture.exists("New.md"));
    assert_eq!(fixture.read("A.md"), "See [[New]].\n");
    assert_eq!(fixture.read("B.md"), b);
}

/// AC1 (LOA-109): a file that changed since planning is skipped, not clobbered.
#[test]
fn stale_files_are_skipped_never_overwritten() {
    let a = "See [[Old]].\n";
    let fixture = Fixture::new(&[("Old.md", "# Old\n"), ("A.md", a)]);
    let vault = vault_of(&["Old.md", "A.md"]);
    let inbound = vec![link_at("A.md", a, "Old", LinkStyle::Wiki)];
    let plan = plan_rename(
        fixture.root(),
        "Old.md",
        "New.md",
        &inbound,
        &vault,
        LinkFormat::ShortestUnique,
    );

    // Someone edits the file between planning and applying.
    let edited = "Edited first. See [[Old]].\n";
    fs::write(fixture.root().join("A.md"), edited).expect("edit");

    let report = apply_rename(fixture.root(), &plan, &Silent, &|| false).expect("apply");
    assert_eq!(report.skipped, vec!["A.md"]);
    assert!(report.changed_files.is_empty());
    // Their edit survives untouched.
    assert_eq!(fixture.read("A.md"), edited);
}

/// A blocked plan is never applied.
#[test]
fn blocked_plans_refuse_to_apply() {
    let note = "Link [[Old]].\n";
    let fixture = Fixture::new(&[
        ("Old.md", "# Old\n"),
        ("Taken.md", "# Taken\n"),
        ("Note.md", note),
    ]);
    let vault = vault_of(&["Old.md", "Taken.md", "Note.md"]);
    let plan = plan_rename(
        fixture.root(),
        "Old.md",
        "Taken.md",
        &[link_at("Note.md", note, "Old", LinkStyle::Wiki)],
        &vault,
        LinkFormat::ShortestUnique,
    );

    match apply_rename(fixture.root(), &plan, &Silent, &|| false) {
        Err(ApplyError::Blocked(problems)) => assert_eq!(problems, plan.problems),
        other => panic!("expected a blocked plan, got {other:?}"),
    }
    // Nothing moved.
    assert!(fixture.exists("Old.md"));
    assert_eq!(fixture.read("Note.md"), note);
}

/// Links naming the note by alias keep their spelling: they still resolve.
#[test]
fn alias_links_are_left_alone() {
    let note = "By alias: [[The Project]].\n";
    let fixture = Fixture::new(&[("Loam.md", "# Loam\n"), ("Note.md", note)]);
    let vault = vec![
        VaultEntry::new("Loam.md", ["The Project"]),
        VaultEntry::new("Note.md", Vec::<String>::new()),
    ];
    let plan = plan_rename(
        fixture.root(),
        "Loam.md",
        "Renamed.md",
        &[link_at("Note.md", note, "The Project", LinkStyle::Wiki)],
        &vault,
        LinkFormat::ShortestUnique,
    );
    // Nothing to rewrite, so the file is not in the plan at all.
    assert_eq!(plan.file_count(), 0);
    assert_eq!(plan.link_count, 0);
}
