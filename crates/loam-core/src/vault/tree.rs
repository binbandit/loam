//! Safe vault tree enumeration (§3.1, §5.6): deterministic order, symlink
//! cycle guards, no escape outside the vault, and NFC-normalized logical names
//! with display round-tripping.

use std::collections::BTreeMap;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use super::open::VaultCounts;

/// Built-in ignores (§3.1). `.loamignore` support is P1; these are always on.
const BUILTIN_IGNORES: &[&str] = &[".git", "node_modules", ".obsidian", ".loam"];

/// Does any segment of this vault-relative path fall under a built-in
/// ignored directory? Used by enumeration here and by the incremental
/// indexer for watcher event paths.
pub fn is_builtin_ignored(logical_path: &str) -> bool {
    logical_path
        .split('/')
        .any(|segment| BUILTIN_IGNORES.contains(&segment))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntryKind {
    Folder,
    Markdown,
    /// Non-Markdown file, carried with metadata only (viewers are E15/P1).
    Other,
    /// A symlink whose target resolves outside the vault: listed, never
    /// followed (§5.6 — enumeration must not escape the capability root).
    ExternalLink,
}

/// One enumerated entry. `logical_path` is the NFC-normalized vault-relative
/// path used for identity and ordering; `display_name` preserves the on-disk
/// name form exactly so platforms that store NFD (macOS) round-trip untouched.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub logical_path: String,
    pub display_name: String,
    pub kind: EntryKind,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTree {
    /// Deterministic: sorted by NFC logical path.
    pub entries: Vec<TreeEntry>,
    /// Symlink cycles encountered and skipped — diagnostics, not failures.
    pub cycle_diagnostics: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum TreeError {
    #[error("failed to enumerate the vault: {0}")]
    Io(#[from] std::io::Error),
}

impl VaultTree {
    pub fn counts(&self) -> VaultCounts {
        let mut counts = VaultCounts {
            notes: 0,
            folders: 0,
            attachments: 0,
        };
        for entry in &self.entries {
            match entry.kind {
                EntryKind::Markdown => counts.notes += 1,
                EntryKind::Folder => counts.folders += 1,
                EntryKind::Other => counts.attachments += 1,
                EntryKind::ExternalLink => {}
            }
        }
        counts
    }
}

/// Enumerate a vault. Symlinked directories are followed (§5.6) with a
/// visited-set cycle guard keyed by canonical path; links resolving outside
/// the canonical root are listed as `ExternalLink` and never descended.
pub fn enumerate(canonical_root: &Path) -> Result<VaultTree, TreeError> {
    let mut tree = VaultTree {
        entries: Vec::new(),
        cycle_diagnostics: Vec::new(),
    };
    // BTreeMap keyed by logical path gives deterministic order AND collapses
    // NFC/NFD duplicates of the same logical entry (AC3).
    let mut collected: BTreeMap<String, TreeEntry> = BTreeMap::new();
    let mut visited_dirs: HashSet<PathBuf> = HashSet::new();
    visited_dirs.insert(canonical_root.to_path_buf());
    walk(
        canonical_root,
        canonical_root,
        "",
        &mut collected,
        &mut visited_dirs,
        &mut tree.cycle_diagnostics,
    )?;
    tree.entries = collected.into_values().collect();
    Ok(tree)
}

fn nfc(name: &str) -> String {
    name.nfc().collect()
}

fn walk(
    canonical_root: &Path,
    dir: &Path,
    prefix: &str,
    collected: &mut BTreeMap<String, TreeEntry>,
    visited_dirs: &mut HashSet<PathBuf>,
    cycles: &mut Vec<String>,
) -> Result<(), TreeError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let display_name = entry.file_name().to_string_lossy().into_owned();
        if BUILTIN_IGNORES.contains(&display_name.as_str())
            || display_name.ends_with(super::writer::TEMP_SUFFIX)
        {
            continue;
        }
        let logical_name = nfc(&display_name);
        let logical_path = if prefix.is_empty() {
            logical_name.clone()
        } else {
            format!("{prefix}/{logical_name}")
        };
        let path = entry.path();
        let file_type = entry.file_type()?;

        if file_type.is_dir() || (file_type.is_symlink() && path.is_dir()) {
            // Resolve once for the escape check and the cycle guard.
            let canonical = match path.canonicalize() {
                Ok(canonical) => canonical,
                Err(_) => continue, // dangling link: skip silently
            };
            if !canonical.starts_with(canonical_root) {
                collected.insert(
                    logical_path.clone(),
                    TreeEntry {
                        logical_path,
                        display_name,
                        kind: EntryKind::ExternalLink,
                        size: 0,
                    },
                );
                continue;
            }
            if !visited_dirs.insert(canonical.clone()) {
                cycles.push(format!(
                    "symlink cycle: {logical_path} resolves to already-visited {}",
                    canonical.display()
                ));
                continue;
            }
            collected.insert(
                logical_path.clone(),
                TreeEntry {
                    logical_path: logical_path.clone(),
                    display_name,
                    kind: EntryKind::Folder,
                    size: 0,
                },
            );
            walk(
                canonical_root,
                &path,
                &logical_path,
                collected,
                visited_dirs,
                cycles,
            )?;
        } else if file_type.is_file() || (file_type.is_symlink() && path.is_file()) {
            if file_type.is_symlink() {
                // File symlinks must not escape either.
                match path.canonicalize() {
                    Ok(canonical) if canonical.starts_with(canonical_root) => {}
                    Ok(_) => {
                        collected.insert(
                            logical_path.clone(),
                            TreeEntry {
                                logical_path,
                                display_name,
                                kind: EntryKind::ExternalLink,
                                size: 0,
                            },
                        );
                        continue;
                    }
                    Err(_) => continue,
                }
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let kind = if logical_name.to_lowercase().ends_with(".md") {
                EntryKind::Markdown
            } else {
                EntryKind::Other
            };
            collected.insert(
                logical_path.clone(),
                TreeEntry {
                    logical_path,
                    display_name,
                    kind,
                    size,
                },
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canon(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().canonicalize().expect("canonical root")
    }

    /// AC2 (determinism): repeated enumeration yields identical ordering, and
    /// built-in ignores never appear.
    #[test]
    fn enumeration_is_deterministic_and_respects_builtin_ignores() {
        let dir = tempfile::tempdir().expect("vault");
        for name in ["b.md", "a.md", "z.png", "notes"] {
            if name.contains('.') {
                std::fs::write(dir.path().join(name), "x").expect("file");
            } else {
                std::fs::create_dir(dir.path().join(name)).expect("dir");
            }
        }
        std::fs::create_dir(dir.path().join(".git")).expect("ignored dir");
        std::fs::create_dir(dir.path().join(".obsidian")).expect("ignored dir");
        std::fs::write(dir.path().join("notes/inner.md"), "x").expect("file");

        let first = enumerate(&canon(&dir)).expect("enumerate");
        let second = enumerate(&canon(&dir)).expect("enumerate again");
        let paths: Vec<_> = first
            .entries
            .iter()
            .map(|e| e.logical_path.clone())
            .collect();
        assert_eq!(
            paths,
            vec!["a.md", "b.md", "notes", "notes/inner.md", "z.png"],
            "sorted, ignores excluded"
        );
        let second_paths: Vec<_> = second
            .entries
            .iter()
            .map(|e| e.logical_path.clone())
            .collect();
        assert_eq!(paths, second_paths, "deterministic across runs");
        assert_eq!(first.counts().notes, 3, "a.md, b.md, notes/inner.md");
        assert_eq!(first.counts().folders, 1);
        assert_eq!(first.counts().attachments, 1);
    }

    /// AC2: a symlink pointing outside the vault is listed but never followed.
    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_the_vault() {
        let outside = tempfile::tempdir().expect("outside");
        std::fs::write(outside.path().join("secret.md"), "outside").expect("outside file");
        let dir = tempfile::tempdir().expect("vault");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).expect("dir link");
        std::os::unix::fs::symlink(
            outside.path().join("secret.md"),
            dir.path().join("secret-link.md"),
        )
        .expect("file link");

        let tree = enumerate(&canon(&dir)).expect("enumerate");
        for entry in &tree.entries {
            assert_eq!(
                entry.kind,
                EntryKind::ExternalLink,
                "{} must be an external link",
                entry.logical_path
            );
        }
        assert!(
            !tree
                .entries
                .iter()
                .any(|e| e.logical_path.contains("secret.md") && e.kind == EntryKind::Markdown),
            "outside content must not be enumerated as vault content"
        );
    }

    /// AC5: a symlink cycle terminates with a diagnostic (nextest's timeout
    /// would kill a hang).
    #[cfg(unix)]
    #[test]
    fn symlink_cycles_terminate_with_a_diagnostic() {
        let dir = tempfile::tempdir().expect("vault");
        let a = dir.path().join("a");
        std::fs::create_dir(&a).expect("a");
        std::os::unix::fs::symlink(dir.path(), a.join("loop")).expect("cycle link");

        let tree = enumerate(&canon(&dir)).expect("terminates");
        assert!(
            !tree.cycle_diagnostics.is_empty(),
            "cycle must be diagnosed: {:?}",
            tree.cycle_diagnostics
        );
    }

    /// AC3: an NFD-named file and its NFC twin collapse to one logical entry;
    /// the display name preserves the on-disk form.
    #[test]
    fn nfc_and_nfd_names_are_one_logical_entry() {
        let dir = tempfile::tempdir().expect("vault");
        let nfd_name = "cafe\u{301}.md"; // e + combining acute
        std::fs::write(dir.path().join(nfd_name), "x").expect("nfd file");

        let tree = enumerate(&canon(&dir)).expect("enumerate");
        let logical: Vec<_> = tree
            .entries
            .iter()
            .map(|e| e.logical_path.clone())
            .collect();
        assert_eq!(logical, vec!["café.md".to_string()], "logical path is NFC");
        // Display round-trips whatever the filesystem stored (APFS may keep
        // either form; both are acceptable as display, and joining the vault
        // root with the display name must reach the file).
        let display = &tree.entries[0].display_name;
        assert!(
            dir.path().join(display).exists(),
            "display name round-trips"
        );
    }
}
