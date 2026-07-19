//! Safe note and folder operations (§3.1, §5.6): create with collision-safe
//! names, rename/move with case-insensitive peer protection, duplicate without
//! overwrite, and delete to the OS trash. There is deliberately **no
//! permanent-delete API** in this module.

use std::path::{Path, PathBuf};

use unicode_normalization::UnicodeNormalization;

use super::note::{NoteError, resolve_in_vault};

/// Full Unicode case fold (ß≡ss etc.) — matches APFS/NTFS insensitive
/// comparison, which simple lowercasing does not (found by the corpus test:
/// APFS treats "Straße" and "strasse" as the same name).

#[derive(Debug, thiserror::Error)]
pub enum OpsError {
    #[error(
        "a file or folder named \"{0}\" already exists (names differing only by case collide on macOS and Windows)"
    )]
    CaseInsensitiveCollision(String),
    #[error("destination already exists: {0}")]
    DestinationExists(String),
    #[error(transparent)]
    Path(#[from] NoteError),
    #[error("could not move \"{0}\" to the system trash: {1}")]
    Trash(String, String),
    #[error("the operation failed: {0}")]
    Io(#[from] std::io::Error),
}

/// Trash backend seam: the real OS trash in production, recordable in tests.
pub trait TrashProvider {
    fn trash(&self, path: &Path) -> Result<(), String>;
}

/// OS trash via the `trash` crate (§5.6 — deletes are always recoverable).
pub struct OsTrash;

impl TrashProvider for OsTrash {
    fn trash(&self, path: &Path) -> Result<(), String> {
        trash::delete(path).map_err(|error| error.to_string())
    }
}

/// Case-fold + NFC key for collision checks: names that collide on
/// case-insensitive filesystems (macOS/Windows) are treated as colliding on
/// every platform, so a vault stays portable (§5.6).
fn collision_key(name: &str) -> String {
    caseless::default_case_fold_str(&name.nfc().collect::<String>())
}

/// Does `dir` already contain an entry whose name collides with `name`?
fn find_collision(dir: &Path, name: &str) -> Result<Option<String>, std::io::Error> {
    let wanted = collision_key(name);
    for entry in std::fs::read_dir(dir)? {
        let existing = entry?.file_name().to_string_lossy().into_owned();
        if collision_key(&existing) == wanted {
            return Ok(Some(existing));
        }
    }
    Ok(None)
}

/// §3.8 unique-name policy: `Title.md`, `Title 1.md`, `Title 2.md`, …
fn unique_name(dir: &Path, stem: &str, extension: Option<&str>) -> Result<String, std::io::Error> {
    let compose = |stem: &str, n: u32| {
        let base = if n == 0 {
            stem.to_string()
        } else {
            format!("{stem} {n}")
        };
        match extension {
            Some(ext) => format!("{base}.{ext}"),
            None => base,
        }
    };
    for n in 0.. {
        let candidate = compose(stem, n);
        // Listing-based fold check PLUS an fs-truth probe: the filesystem's
        // own folding (APFS/NTFS) is authoritative for exotic equivalences.
        if find_collision(dir, &candidate)?.is_none() && !dir.join(&candidate).exists() {
            return Ok(candidate);
        }
    }
    unreachable!("u32 candidate space exhausted");
}

/// Create a new note with the §3.8 collision policy. Returns the
/// vault-relative path actually created.
pub fn create_note(
    canonical_root: &Path,
    folder: &str,
    title: &str,
    content: &str,
) -> Result<String, OpsError> {
    let dir = resolve_dir(canonical_root, folder)?;
    let name = unique_name(&dir, title, Some("md"))?;
    // Fresh unique name → base_hash None create via the atomic writer.
    let relative = join_relative(folder, &name);
    super::writer::note_write(
        canonical_root,
        &relative,
        content,
        None,
        &super::writer::NullSink,
    )
    .map_err(|error| match error {
        super::writer::WriteError::Io(io) => OpsError::Io(io),
        other => OpsError::Io(std::io::Error::other(other.to_string())),
    })?;
    Ok(relative)
}

/// Create a folder with the same collision policy.
pub fn create_folder(canonical_root: &Path, parent: &str, name: &str) -> Result<String, OpsError> {
    let dir = resolve_dir(canonical_root, parent)?;
    let unique = unique_name(&dir, name, None)?;
    std::fs::create_dir(dir.join(&unique))?;
    Ok(join_relative(parent, &unique))
}

/// Rename or move a file/folder within the vault. Never overwrites — including
/// case-insensitive peers — except for the pure case-rename of the same entry.
pub fn rename(canonical_root: &Path, from: &str, to: &str) -> Result<(), OpsError> {
    let source = resolve_in_vault(canonical_root, from)?;
    let (to_parent, to_name) = split(to);
    let dest_dir = resolve_dir(canonical_root, to_parent)?;
    let destination = dest_dir.join(&to_name);

    let same_entry_case_rename = source.parent() == Some(dest_dir.as_path())
        && collision_key(&file_name(&source)) == collision_key(&to_name);
    if !same_entry_case_rename && let Some(existing) = find_collision(&dest_dir, &to_name)? {
        return Err(if existing == to_name {
            OpsError::DestinationExists(to.to_string())
        } else {
            OpsError::CaseInsensitiveCollision(existing)
        });
    }
    std::fs::rename(&source, &destination)?;
    Ok(())
}

/// Duplicate a file as `Name 1.md` (etc.) without ever overwriting.
pub fn duplicate(canonical_root: &Path, relative: &str) -> Result<String, OpsError> {
    let source = resolve_in_vault(canonical_root, relative)?;
    let (parent_rel, name) = split(relative);
    let dir = resolve_dir(canonical_root, parent_rel)?;
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), Some(ext.to_string())),
        _ => (name.clone(), None),
    };
    let unique = unique_name(&dir, &stem, extension.as_deref())?;
    std::fs::copy(&source, dir.join(&unique))?;
    Ok(join_relative(parent_rel, &unique))
}

/// Delete to the OS trash (§5.6: always recoverable; no permanent delete).
pub fn delete_to_trash(
    canonical_root: &Path,
    relative: &str,
    provider: &dyn TrashProvider,
) -> Result<(), OpsError> {
    let target = resolve_in_vault(canonical_root, relative)?;
    provider
        .trash(&target)
        .map_err(|reason| OpsError::Trash(relative.to_string(), reason))
}

fn resolve_dir(canonical_root: &Path, relative: &str) -> Result<PathBuf, OpsError> {
    if relative.is_empty() {
        return Ok(canonical_root.to_path_buf());
    }
    let dir = resolve_in_vault(canonical_root, relative)?;
    if !dir.is_dir() {
        return Err(OpsError::Path(NoteError::NotAFile(dir)));
    }
    Ok(dir)
}

fn split(relative: &str) -> (&str, String) {
    match relative.trim_matches('/').rsplit_once('/') {
        Some((parent, name)) => (parent, name.to_string()),
        None => ("", relative.trim_matches('/').to_string()),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn join_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", parent.trim_matches('/'), name)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct RecordingTrash(Mutex<Vec<PathBuf>>);

    impl RecordingTrash {
        fn new() -> Self {
            Self(Mutex::new(Vec::new()))
        }
        fn trashed(&self) -> Vec<PathBuf> {
            self.0.lock().expect("lock").clone()
        }
    }

    impl TrashProvider for RecordingTrash {
        fn trash(&self, path: &Path) -> Result<(), String> {
            // Behave like a real trash: the entry leaves the vault.
            std::fs::remove_file(path)
                .or_else(|_| std::fs::remove_dir_all(path))
                .map_err(|e| e.to_string())?;
            self.0.lock().expect("lock").push(path.to_path_buf());
            Ok(())
        }
    }

    struct FailingTrash;

    impl TrashProvider for FailingTrash {
        fn trash(&self, _path: &Path) -> Result<(), String> {
            Err("trash service unavailable".into())
        }
    }

    fn vault() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("vault");
        let root = dir.path().canonicalize().expect("canonical");
        (dir, root)
    }

    /// AC1: the §3.8 `Title 1` collision pattern, for notes and folders.
    #[test]
    fn create_uses_the_unique_name_pattern() {
        let (_dir, root) = vault();
        assert_eq!(
            create_note(&root, "", "Idea", "x").expect("first"),
            "Idea.md"
        );
        assert_eq!(
            create_note(&root, "", "Idea", "y").expect("second"),
            "Idea 1.md"
        );
        assert_eq!(
            create_note(&root, "", "idea", "z").expect("case-fold collision"),
            "idea 2.md",
            "case-insensitive peers count as collisions"
        );
        assert_eq!(
            create_folder(&root, "", "Projects").expect("folder"),
            "Projects"
        );
        assert_eq!(
            create_folder(&root, "", "projects").expect("folder collision"),
            "projects 1"
        );
    }

    /// AC2: rename/move never overwrites a case-insensitive peer, but a pure
    /// case-rename of the same entry is allowed.
    #[test]
    fn rename_protects_case_insensitive_peers() {
        let (_dir, root) = vault();
        create_note(&root, "", "Alpha", "a").expect("alpha");
        create_note(&root, "", "Beta", "b").expect("beta");

        assert!(matches!(
            rename(&root, "Beta.md", "alpha.md"),
            Err(OpsError::CaseInsensitiveCollision(_))
        ));
        assert!(matches!(
            rename(&root, "Beta.md", "Alpha.md"),
            Err(OpsError::DestinationExists(_) | OpsError::CaseInsensitiveCollision(_))
        ));
        // Sources untouched by the refused operations (AC5).
        assert!(root.join("Alpha.md").exists());
        assert!(root.join("Beta.md").exists());

        // Pure case-rename of the same file is legitimate.
        rename(&root, "Beta.md", "beta.md").expect("case rename");
        // Move into a folder.
        create_folder(&root, "", "notes").expect("folder");
        rename(&root, "beta.md", "notes/beta.md").expect("move");
        assert!(root.join("notes/beta.md").exists());
    }

    /// AC3: delete goes through the trash provider — the OS trash in
    /// production (`OsTrash` wraps the `trash` crate); a recording double here
    /// verifies the integration contract without polluting the developer's
    /// real trash.
    #[test]
    fn delete_goes_to_trash() {
        let (_dir, root) = vault();
        create_note(&root, "", "Doomed", "x").expect("note");
        let recorder = RecordingTrash::new();
        delete_to_trash(&root, "Doomed.md", &recorder).expect("trash");
        assert!(!root.join("Doomed.md").exists());
        assert_eq!(recorder.trashed().len(), 1);
    }

    /// AC4: no operation escapes the vault via traversal or symlink.
    #[test]
    fn operations_cannot_escape_the_vault() {
        let (_dir, root) = vault();
        create_note(&root, "", "Note", "x").expect("note");

        assert!(create_note(&root, "../outside", "Evil", "x").is_err());
        assert!(rename(&root, "Note.md", "../../stolen.md").is_err());
        assert!(delete_to_trash(&root, "../Note.md", &RecordingTrash::new()).is_err());

        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().expect("outside");
            std::os::unix::fs::symlink(outside.path(), root.join("portal")).expect("link");
            // The symlinked dir resolves outside the canonical root: refused.
            assert!(create_note(&root, "portal", "Evil", "x").is_err());
            assert!(outside.path().read_dir().expect("outside").next().is_none());
        }
    }

    /// AC5: failures are typed, actionable, and leave both endpoints unchanged.
    #[test]
    fn failures_leave_source_and_destination_unchanged() {
        let (_dir, root) = vault();
        create_note(&root, "", "Keep", "original").expect("note");

        let failed = delete_to_trash(&root, "Keep.md", &FailingTrash);
        match failed {
            Err(OpsError::Trash(path, reason)) => {
                assert_eq!(path, "Keep.md");
                assert!(reason.contains("unavailable"), "cause is stated");
            }
            other => panic!("expected trash error, got {other:?}"),
        }
        assert_eq!(
            std::fs::read_to_string(root.join("Keep.md")).expect("read"),
            "original",
            "failed delete leaves the file"
        );

        let missing = rename(&root, "Ghost.md", "Real.md");
        assert!(matches!(
            missing,
            Err(OpsError::Path(NoteError::NotFound(_)))
        ));
        assert!(!root.join("Real.md").exists(), "no destination side-effect");
    }

    /// LOA-46 AC1: case-fold collision corpus — pairs that collide on
    /// case-insensitive filesystems are rejected on EVERY platform.
    #[test]
    fn case_fold_collision_corpus() {
        let corpus = [
            ("Notes", "notes"),
            ("README", "readme"),
            ("Straße", "strasse"), // collides: full fold maps ß to ss (APFS)
            ("CAFÉ", "café"),
            ("МОСКВА", "москва"),
        ];
        for (a, b) in corpus {
            let (_dir, root) = vault();
            create_folder(&root, "", a).expect("first");
            let second = create_folder(&root, "", b).expect("second");
            if caseless::default_case_fold_str(a) == caseless::default_case_fold_str(b) {
                assert_eq!(second, format!("{b} 1"), "{a}/{b} must collide");
            } else {
                assert_eq!(second, b, "{a}/{b} must not collide");
            }
        }
    }

    /// LOA-46 AC3: reading and writing an NFD-named file never renames it —
    /// the on-disk byte name is preserved.
    #[test]
    fn nfd_names_survive_read_and_write() {
        let (_dir, root) = vault();
        let nfd_name = "cafe\u{301}.md";
        std::fs::write(root.join(nfd_name), "v1").expect("nfd file");
        let listing_before: Vec<_> = std::fs::read_dir(&root)
            .expect("dir")
            .map(|e| e.expect("entry").file_name())
            .collect();

        let doc = super::super::note::note_read(&root, nfd_name).expect("read");
        let base = doc.hash.clone();
        super::super::writer::note_write(
            &root,
            nfd_name,
            "v2",
            Some(&base),
            &super::super::writer::NullSink,
        )
        .expect("write");

        let listing_after: Vec<_> = std::fs::read_dir(&root)
            .expect("dir")
            .map(|e| e.expect("entry").file_name())
            .collect();
        assert_eq!(listing_before, listing_after, "no rename from IO");
        assert_eq!(listing_after.len(), 1, "still exactly one file");
    }

    /// Duplicate never overwrites and follows the numbering pattern.
    #[test]
    fn duplicate_finds_the_next_free_name() {
        let (_dir, root) = vault();
        create_note(&root, "", "Doc", "content").expect("note");
        assert_eq!(duplicate(&root, "Doc.md").expect("dup 1"), "Doc 1.md");
        assert_eq!(duplicate(&root, "Doc.md").expect("dup 2"), "Doc 2.md");
        assert_eq!(
            std::fs::read_to_string(root.join("Doc 2.md")).expect("read"),
            "content"
        );
    }

    /// The real `OsTrash` provider exists and compiles against the `trash`
    /// crate; end-to-end OS integration runs where CI opts in (real trash
    /// pollution is deliberate there).
    #[test]
    fn os_trash_round_trip_when_opted_in() {
        if std::env::var("LOAM_TEST_REAL_TRASH").as_deref() != Ok("1") {
            // Provider construction still exercised.
            let _provider = OsTrash;
            return;
        }
        let (_dir, root) = vault();
        create_note(&root, "", "TrashMe", "x").expect("note");
        delete_to_trash(&root, "TrashMe.md", &OsTrash).expect("real trash");
        assert!(!root.join("TrashMe.md").exists());
    }
}
