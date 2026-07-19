//! Path hardening (§5.6): normalized vault-relative paths as the internal
//! currency, with OS paths constructed only at the filesystem boundary —
//! including Windows extended-length (`\\?\`) conversion for MAX_PATH.

use std::path::{Path, PathBuf};

use unicode_normalization::UnicodeNormalization;

/// Windows MAX_PATH; longer absolute paths need the `\\?\` prefix.
pub const WINDOWS_MAX_PATH: usize = 260;

/// A normalized vault-relative path: NFC, forward slashes, no empty/`.`/`..`
/// segments. The single type core APIs traffic in; the OS boundary is
/// [`VaultRelPath::to_os`].
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct VaultRelPath(String);

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("empty path")]
    Empty,
    #[error("path traversal segments are not allowed: {0}")]
    Traversal(String),
}

impl VaultRelPath {
    pub fn new(raw: &str) -> Result<Self, PathError> {
        let normalized: String = raw.replace('\\', "/").nfc().collect();
        let mut segments = Vec::new();
        for segment in normalized.split('/') {
            match segment {
                "" | "." => continue,
                ".." => return Err(PathError::Traversal(raw.to_string())),
                other => segments.push(other),
            }
        }
        if segments.is_empty() {
            return Err(PathError::Empty);
        }
        Ok(Self(segments.join("/")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Construct the OS path — the only place a relative path becomes real.
    pub fn to_os(&self, canonical_root: &Path) -> PathBuf {
        let joined = canonical_root.join(self.0.replace('/', std::path::MAIN_SEPARATOR_STR));
        to_extended_length(&joined)
    }
}

impl std::fmt::Display for VaultRelPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Windows extended-length adapter (§5.6): absolute paths at or beyond
/// MAX_PATH get the `\\?\` prefix (`\\?\UNC\` for shares); everything else —
/// and every non-Windows platform — passes through unchanged. Pure string
/// logic, unit-tested on all platforms via [`extended_length_string`].
pub fn to_extended_length(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(extended_length_string(&path.to_string_lossy()))
    } else {
        path.to_path_buf()
    }
}

/// The conversion itself, platform-independent for testing.
pub fn extended_length_string(path: &str) -> String {
    let already_verbatim = path.starts_with("\\\\?\\");
    let is_drive_absolute = path.as_bytes().get(1).is_some_and(|b| *b == b':')
        && path
            .as_bytes()
            .get(2)
            .is_some_and(|b| *b == b'\\' || *b == b'/');
    let is_unc = path.starts_with("\\\\") && !already_verbatim;

    if already_verbatim || path.len() < WINDOWS_MAX_PATH {
        return path.to_string();
    }
    if is_unc {
        format!("\\\\?\\UNC\\{}", path[2..].replace('/', "\\"))
    } else if is_drive_absolute {
        format!("\\\\?\\{}", path.replace('/', "\\"))
    } else {
        path.to_string() // relative paths cannot take the verbatim prefix
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_rel_paths_normalize_and_reject_traversal() {
        let nfd = "notes/cafe\u{301}.md";
        let path = VaultRelPath::new(nfd).expect("normalizes");
        assert_eq!(path.as_str(), "notes/café.md", "NFC internally");

        assert_eq!(
            VaultRelPath::new("a\\b\\c.md")
                .expect("backslashes")
                .as_str(),
            "a/b/c.md"
        );
        assert_eq!(
            VaultRelPath::new("./a//b/./c.md").expect("dots").as_str(),
            "a/b/c.md"
        );
        assert!(matches!(VaultRelPath::new(""), Err(PathError::Empty)));
        assert!(matches!(
            VaultRelPath::new("../escape.md"),
            Err(PathError::Traversal(_))
        ));
        assert!(matches!(
            VaultRelPath::new("a/../../b.md"),
            Err(PathError::Traversal(_))
        ));
    }

    /// AC2 (logic, all platforms; behavior exercised on Windows CI): the
    /// extended-length conversion for MAX_PATH and UNC paths.
    #[test]
    fn extended_length_conversion_matrix() {
        let long_tail = "a".repeat(WINDOWS_MAX_PATH);
        // Short paths pass through untouched.
        assert_eq!(
            extended_length_string("C:\\short\\note.md"),
            "C:\\short\\note.md"
        );
        // Long drive-absolute paths gain the verbatim prefix.
        let long = format!("C:\\vault\\{long_tail}.md");
        assert_eq!(
            extended_length_string(&long),
            format!("\\\\?\\{long}"),
            "long drive paths become verbatim"
        );
        // Long UNC paths use the UNC verbatim form.
        let unc = format!("\\\\server\\share\\{long_tail}.md");
        assert_eq!(
            extended_length_string(&unc),
            format!("\\\\?\\UNC\\server\\share\\{long_tail}.md")
        );
        // Already-verbatim paths are left alone.
        let verbatim = format!("\\\\?\\C:\\vault\\{long_tail}.md");
        assert_eq!(extended_length_string(&verbatim), verbatim);
        // Relative paths never take the prefix.
        let relative = format!("vault\\{long_tail}.md");
        assert_eq!(extended_length_string(&relative), relative);
    }

    #[test]
    fn to_os_round_trips_through_the_boundary() {
        let root = Path::new("/vaults/main");
        let path = VaultRelPath::new("notes/idea.md").expect("path");
        let os = path.to_os(root);
        assert!(os.starts_with(root));
        assert!(os.ends_with(Path::new("notes").join("idea.md")));
    }
}
