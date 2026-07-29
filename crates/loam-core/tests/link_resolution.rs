//! LOA-94: §3.4 internal-link resolution — precedence, ambiguity, and the
//! guarantee that wikilinks and Markdown links mean the same thing.

use loam_core::links::{MatchKind, Resolution, VaultEntry, resolve_link, resolve_target};
use loam_core::parse::{LinkRef, LinkStyle, SourceRange, WikiComponents};

/// A vault where one name is deliberately reachable three different ways.
fn vault() -> Vec<VaultEntry> {
    vec![
        VaultEntry::new("Loam.md", Vec::<String>::new()),
        VaultEntry::new("Projects/Loam.md", ["The Project"]),
        VaultEntry::new("Projects/Deep/Notes.md", Vec::<String>::new()),
        VaultEntry::new("Archive/2025/Notes.md", Vec::<String>::new()),
        VaultEntry::new("Reading list.md", ["Books", "To Read"]),
        VaultEntry::new("Notebooks/Garden.md", Vec::<String>::new()),
        VaultEntry::new("Daily/2026-07-29.md", Vec::<String>::new()),
    ]
}

fn resolved(resolution: &Resolution) -> (&str, MatchKind) {
    match resolution {
        Resolution::Resolved { path, kind, .. } => (path.as_str(), *kind),
        other => panic!("expected a resolved link, got {other:?}"),
    }
}

fn candidates(resolution: &Resolution) -> Vec<&str> {
    match resolution {
        Resolution::Ambiguous { candidates } => {
            candidates.iter().map(|c| c.path.as_str()).collect()
        }
        other => panic!("expected an ambiguous link, got {other:?}"),
    }
}

/// AC1: an exact path wins over a filename or alias that spells the same.
#[test]
fn exact_path_beats_filename_and_alias() {
    let vault = vault();

    // `Projects/Loam` is a path; the bare `Loam.md` at the root must not win.
    let by_path = resolve_target("Projects/Loam", "Daily/2026-07-29.md", &vault);
    assert_eq!(
        resolved(&by_path),
        ("Projects/Loam.md", MatchKind::ExactPath)
    );

    // With the extension spelled out, same answer.
    let with_extension = resolve_target("Projects/Loam.md", "Daily/2026-07-29.md", &vault);
    assert_eq!(
        resolved(&with_extension),
        ("Projects/Loam.md", MatchKind::ExactPath)
    );

    // A path that also happens to be an alias resolves by path first.
    let aliased = vec![
        VaultEntry::new("Alpha.md", Vec::<String>::new()),
        VaultEntry::new("Beta.md", ["Alpha"]),
    ];
    let precedence = resolve_target("Alpha", "Beta.md", &aliased);
    assert_eq!(resolved(&precedence), ("Alpha.md", MatchKind::ExactPath));
}

/// AC1: case is not significant anywhere in resolution (§3.4).
#[test]
fn resolution_is_case_insensitive() {
    let vault = vault();
    assert_eq!(
        resolved(&resolve_target("pRoJeCtS/lOaM", "Loam.md", &vault)),
        ("Projects/Loam.md", MatchKind::ExactPath)
    );
    // A root-level note is reachable by its own name as an exact path, so
    // that rule wins; the filename rule is what finds a nested note.
    assert_eq!(
        resolved(&resolve_target("READING LIST", "Loam.md", &vault)),
        ("Reading list.md", MatchKind::ExactPath)
    );
    assert_eq!(
        resolved(&resolve_target("gArDeN", "Loam.md", &vault)),
        ("Notebooks/Garden.md", MatchKind::Filename)
    );
    assert_eq!(
        resolved(&resolve_target("the project", "Loam.md", &vault)),
        ("Projects/Loam.md", MatchKind::Alias)
    );
}

/// AC2: a filename that exists once resolves from anywhere in the vault.
#[test]
fn unique_filename_resolves_from_any_folder() {
    let vault = vec![
        VaultEntry::new("Archive/Deep/Nested/Unique.md", Vec::<String>::new()),
        VaultEntry::new("Daily/2026-07-29.md", Vec::<String>::new()),
    ];
    let resolution = resolve_target("Unique", "Daily/2026-07-29.md", &vault);
    assert_eq!(
        resolved(&resolution),
        ("Archive/Deep/Nested/Unique.md", MatchKind::Filename)
    );

    // A *path* that does not exist stays unresolved — the filename rule is
    // only for bare names, or `Wrong/Unique` would silently find it.
    assert_eq!(
        resolve_target("Wrong/Unique", "Daily/2026-07-29.md", &vault),
        Resolution::Unresolved
    );
}

/// AC3: aliases resolve, but only after the path and filename rules.
#[test]
fn aliases_resolve_last() {
    let vault = vault();
    assert_eq!(
        resolved(&resolve_target("Books", "Loam.md", &vault)),
        ("Reading list.md", MatchKind::Alias)
    );
    assert_eq!(
        resolved(&resolve_target("To Read", "Loam.md", &vault)),
        ("Reading list.md", MatchKind::Alias)
    );

    // A filename match wins over another note's alias for the same word.
    let vault = vec![
        VaultEntry::new("Inbox/Ideas.md", Vec::<String>::new()),
        VaultEntry::new("Other.md", ["Ideas"]),
    ];
    assert_eq!(
        resolved(&resolve_target("Ideas", "Other.md", &vault)),
        ("Inbox/Ideas.md", MatchKind::Filename)
    );
}

/// AC4: ambiguity is reported, never guessed, and ordered deterministically.
#[test]
fn ambiguous_names_return_ranked_candidates() {
    let vault = vault();

    // Two `Notes.md` in different folders: nearest path to the linking note
    // comes first.
    let from_projects = resolve_target("Notes", "Projects/Loam.md", &vault);
    assert_eq!(
        candidates(&from_projects),
        vec!["Projects/Deep/Notes.md", "Archive/2025/Notes.md"]
    );

    let from_archive = resolve_target("Notes", "Archive/2025/Old.md", &vault);
    assert_eq!(
        candidates(&from_archive),
        vec!["Archive/2025/Notes.md", "Projects/Deep/Notes.md"]
    );

    // Same inputs, same order, every time.
    for _ in 0..5 {
        assert_eq!(
            candidates(&resolve_target("Notes", "Projects/Loam.md", &vault)),
            vec!["Projects/Deep/Notes.md", "Archive/2025/Notes.md"]
        );
    }
}

/// AC4: with no shared folder, the shallower path wins, then alphabetical.
#[test]
fn ambiguity_falls_back_to_depth_then_alphabetical() {
    let vault = vec![
        VaultEntry::new("Deep/Folder/Here/Same.md", Vec::<String>::new()),
        VaultEntry::new("Beta/Same.md", Vec::<String>::new()),
        VaultEntry::new("Alpha/Same.md", Vec::<String>::new()),
    ];
    // None of these share a folder with the asking note, so ranking falls to
    // the shallowest path, then alphabetical order.
    let resolution = resolve_target("Same", "Unrelated/Note.md", &vault);
    assert_eq!(
        candidates(&resolution),
        vec!["Alpha/Same.md", "Beta/Same.md", "Deep/Folder/Here/Same.md"]
    );
}

/// AC5: Markdown links and wikilinks go through one engine.
#[test]
fn markdown_and_wikilinks_resolve_identically() {
    let vault = vault();
    let from = "Daily/2026-07-29.md";

    let wiki = LinkRef {
        target: "Projects/Loam#Goals".into(),
        text: "Projects/Loam#Goals".into(),
        style: LinkStyle::Wiki,
        embed: false,
        components: Some(WikiComponents {
            note: "Projects/Loam".into(),
            heading: Some("Goals".into()),
            block: None,
        }),
        range: SourceRange { start: 0, end: 0 },
    };
    let markdown = LinkRef {
        target: "Projects/Loam.md#Goals".into(),
        text: "see goals".into(),
        style: LinkStyle::Markdown,
        embed: false,
        components: None,
        range: SourceRange { start: 0, end: 0 },
    };

    let from_wiki = resolve_link(&wiki, from, &vault);
    let from_markdown = resolve_link(&markdown, from, &vault);
    assert_eq!(from_wiki, from_markdown);
    match from_wiki {
        Resolution::Resolved { path, heading, .. } => {
            assert_eq!(path, "Projects/Loam.md");
            assert_eq!(heading.as_deref(), Some("Goals"));
        }
        other => panic!("expected resolution, got {other:?}"),
    }
}

/// Fragments: headings, blocks, and same-note references.
#[test]
fn fragments_are_carried_through() {
    let vault = vault();
    match resolve_target("Loam#^abc123", "Daily/2026-07-29.md", &vault) {
        Resolution::Resolved { path, block, .. } => {
            assert_eq!(path, "Loam.md");
            assert_eq!(block.as_deref(), Some("abc123"));
        }
        other => panic!("expected resolution, got {other:?}"),
    }

    // `[[#Heading]]` points inside the note doing the linking.
    match resolve_target("#Later", "Daily/2026-07-29.md", &vault) {
        Resolution::Resolved { path, heading, .. } => {
            assert_eq!(path, "Daily/2026-07-29.md");
            assert_eq!(heading.as_deref(), Some("Later"));
        }
        other => panic!("expected resolution, got {other:?}"),
    }
}

/// Markdown links from other tools escape spaces; they still resolve.
#[test]
fn percent_escapes_are_decoded() {
    let vault = vault();
    assert_eq!(
        resolved(&resolve_target("Reading%20list.md", "Loam.md", &vault)),
        ("Reading list.md", MatchKind::ExactPath)
    );
    assert_eq!(
        resolved(&resolve_target("./Reading%20list", "Loam.md", &vault)),
        ("Reading list.md", MatchKind::ExactPath)
    );
}

/// External targets are not the resolver's business.
#[test]
fn external_targets_are_left_alone() {
    let vault = vault();
    for target in [
        "https://example.com/x",
        "http://example.com",
        "mailto:a@b.c",
        "obsidian://open?vault=x",
    ] {
        assert_eq!(
            resolve_target(target, "Loam.md", &vault),
            Resolution::External,
            "{target}"
        );
    }
}

/// A name nothing matches is unresolved — a normal, creatable state.
#[test]
fn unknown_names_are_unresolved() {
    let vault = vault();
    assert_eq!(
        resolve_target("Nothing Here", "Loam.md", &vault),
        Resolution::Unresolved
    );
    assert_eq!(resolve_target("", "Loam.md", &vault).clone(), {
        // An empty target is a same-note reference with no fragment.
        Resolution::Resolved {
            path: "Loam.md".into(),
            kind: MatchKind::ExactPath,
            heading: None,
            block: None,
        }
    });
}

/// Resolution never depends on which note is asking (only ordering does).
#[test]
fn the_asking_note_never_changes_the_answer() {
    let vault = vault();
    let targets = ["Projects/Loam", "Reading list", "Books", "Nothing"];
    for target in targets {
        let a = resolve_target(target, "Loam.md", &vault);
        let b = resolve_target(target, "Archive/2025/Notes.md", &vault);
        assert_eq!(a, b, "{target} resolved differently by source note");
    }
}

/// A root-level note is its own exact path, which outranks the filename
/// rule. Worth stating: it is the one place the two rules overlap.
#[test]
fn a_root_note_matches_by_path_not_filename() {
    let vault = vec![
        VaultEntry::new("Loam.md", Vec::<String>::new()),
        VaultEntry::new("Nested/Only.md", Vec::<String>::new()),
    ];
    assert_eq!(
        resolved(&resolve_target("Loam", "Nested/Only.md", &vault)),
        ("Loam.md", MatchKind::ExactPath)
    );
    assert_eq!(
        resolved(&resolve_target("Only", "Loam.md", &vault)),
        ("Nested/Only.md", MatchKind::Filename)
    );
}
