//! Note reads (§5.4 `note_read(path) -> NoteDoc`, §5.6 size policy): content +
//! blake3 base hash for conflict-safe writes, size/read-only metadata, the
//! over-2 MB Source-only and over-20 MB metadata-only policies, and typed
//! detection of dataless cloud placeholders.

use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

use serde::Serialize;

/// §5.6 thresholds: >2 MB degrades to Source mode; >20 MB is metadata-only.
pub const SOURCE_ONLY_BYTES: u64 = 2 * 1024 * 1024;
pub const METADATA_ONLY_BYTES: u64 = 20 * 1024 * 1024;

/// Stable blake3 content hash, hex-encoded. The write path (LOA-28) compares
/// this as `base_hash` for conflict detection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ContentHash(String);

impl ContentHash {
    pub fn of(bytes: &[u8]) -> Self {
        Self(blake3::hash(bytes).to_hex().to_string())
    }

    /// Rehydrate a hash previously produced by [`ContentHash::of`] (e.g. a
    /// `base_hash` arriving over IPC). The value is compared, never trusted
    /// as content.
    pub fn from_hex(hex: impl Into<String>) -> Self {
        Self(hex.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SizePolicy {
    /// Normal note: all editor modes available.
    Normal,
    /// >2 MB: Source-mode only (§5.6); content still returned.
    SourceOnly,
    /// >20 MB: not read into memory; metadata (and hash) only.
    MetadataOnly,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub size: u64,
    /// Milliseconds since the Unix epoch, if the platform reports mtime.
    pub modified_ms: Option<u64>,
    pub read_only: bool,
    pub size_policy: SizePolicy,
    /// Timing instrumentation for the §5.9 <80 ms cached-open budget.
    pub read_ms: u128,
}

/// §5.4 `NoteDoc`: content, hash, meta. `content` is `None` under the
/// metadata-only policy; the hash is always computed so conflict-safe writes
/// remain possible for every file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDoc {
    pub relative_path: String,
    pub content: Option<String>,
    pub hash: ContentHash,
    pub meta: NoteMeta,
}

#[derive(Debug, thiserror::Error)]
pub enum NoteError {
    #[error("path resolves outside the vault: {0}")]
    OutsideVault(PathBuf),
    #[error("note does not exist: {0}")]
    NotFound(PathBuf),
    #[error("not a file: {0}")]
    NotAFile(PathBuf),
    #[error("note is not valid UTF-8: {0}")]
    NotUtf8(PathBuf),
    #[error("file is a dataless cloud placeholder and must be materialized before reading: {0}")]
    MaterializationRequired(PathBuf),
    #[error("failed to read the note: {0}")]
    Io(#[from] std::io::Error),
}

/// Resolve a vault-relative path against the canonical root, rejecting any
/// escape (traversal or symlink) outside the capability boundary.
pub fn resolve_in_vault(canonical_root: &Path, relative: &str) -> Result<PathBuf, NoteError> {
    let joined = canonical_root.join(relative);
    let canonical = joined.canonicalize().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => NoteError::NotFound(joined.clone()),
        _ => NoteError::Io(error),
    })?;
    if !canonical.starts_with(canonical_root) {
        return Err(NoteError::OutsideVault(canonical));
    }
    Ok(canonical)
}

/// Read a note (§5.4). Placeholder files fail with a typed
/// `MaterializationRequired` instead of blocking on a cloud download or
/// returning silent garbage.
pub fn note_read(canonical_root: &Path, relative: &str) -> Result<NoteDoc, NoteError> {
    let started = Instant::now();
    let path = resolve_in_vault(canonical_root, relative)?;
    let metadata = std::fs::metadata(&path)?;
    if !metadata.is_file() {
        return Err(NoteError::NotAFile(path));
    }
    if placeholder::is_dataless(&metadata) {
        return Err(NoteError::MaterializationRequired(path));
    }

    let size = metadata.len();
    let size_policy = classify_size(size);
    let read_only = metadata.permissions().readonly();
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));

    let bytes = std::fs::read(&path)?;
    let hash = ContentHash::of(&bytes);
    let content = match size_policy {
        SizePolicy::MetadataOnly => None,
        _ => Some(String::from_utf8(bytes).map_err(|_| NoteError::NotUtf8(path.clone()))?),
    };

    Ok(NoteDoc {
        relative_path: relative.to_string(),
        content,
        hash,
        meta: NoteMeta {
            size,
            modified_ms,
            read_only,
            size_policy,
            read_ms: started.elapsed().as_millis(),
        },
    })
}

pub fn classify_size(size: u64) -> SizePolicy {
    if size > METADATA_ONLY_BYTES {
        SizePolicy::MetadataOnly
    } else if size > SOURCE_ONLY_BYTES {
        SizePolicy::SourceOnly
    } else {
        SizePolicy::Normal
    }
}

/// Dataless cloud-placeholder detection (§5.6), kept in one platform-gated
/// module with a pure, fixture-testable classifier per platform.
pub mod placeholder {
    /// macOS: `SF_DATALESS` in `st_flags` marks an APFS dataless file
    /// (iCloud "evict"-ed); reading would trigger implicit materialization or
    /// fail, so surface it explicitly instead.
    pub const MACOS_SF_DATALESS: u32 = 0x4000_0000;
    /// Windows: `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` marks OneDrive-style
    /// dehydrated files.
    pub const WINDOWS_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

    /// Pure classifiers, unit-testable on any platform with fixture values.
    pub fn macos_flags_are_dataless(st_flags: u32) -> bool {
        st_flags & MACOS_SF_DATALESS != 0
    }

    pub fn windows_attributes_are_dataless(attributes: u32) -> bool {
        attributes & WINDOWS_RECALL_ON_DATA_ACCESS != 0
    }

    #[cfg(target_os = "macos")]
    pub fn is_dataless(metadata: &std::fs::Metadata) -> bool {
        use std::os::macos::fs::MetadataExt;
        macos_flags_are_dataless(metadata.st_flags())
    }

    #[cfg(windows)]
    pub fn is_dataless(metadata: &std::fs::Metadata) -> bool {
        use std::os::windows::fs::MetadataExt;
        windows_attributes_are_dataless(metadata.file_attributes())
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    pub fn is_dataless(_metadata: &std::fs::Metadata) -> bool {
        false // no mainstream dataless-placeholder scheme on Linux
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_with(files: &[(&str, &[u8])]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("vault");
        for (name, contents) in files {
            let path = dir.path().join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("parents");
            }
            std::fs::write(path, contents).expect("file");
        }
        let root = dir.path().canonicalize().expect("canonical");
        (dir, root)
    }

    /// AC1: byte-identical content and the correct blake3 hash.
    #[test]
    fn normal_note_round_trips_content_and_hash() {
        let body = "# Title\n\ncontenu — 内容\n";
        let (_dir, root) = vault_with(&[("Note.md", body.as_bytes())]);
        let doc = note_read(&root, "Note.md").expect("read");
        assert_eq!(doc.content.as_deref(), Some(body));
        assert_eq!(doc.hash, ContentHash::of(body.as_bytes()));
        assert_eq!(
            doc.hash.as_str(),
            blake3::hash(body.as_bytes()).to_hex().to_string()
        );
        assert_eq!(doc.meta.size_policy, SizePolicy::Normal);
        assert!(doc.meta.modified_ms.is_some());
        assert!(!doc.meta.read_only);
        // §5.9 cached-open budget instrumentation (generous CI ceiling).
        assert!(
            doc.meta.read_ms < 80,
            "small read took {}ms",
            doc.meta.read_ms
        );
    }

    /// AC2: traversal and symlink escapes are rejected.
    #[test]
    fn paths_outside_the_vault_are_rejected() {
        let (_dir, root) = vault_with(&[("Note.md", b"x")]);
        // `..` traversal to a real outside file.
        let err = note_read(&root, "../../etc/hosts");
        assert!(
            matches!(
                err,
                Err(NoteError::OutsideVault(_)) | Err(NoteError::NotFound(_))
            ),
            "traversal must not read outside: {err:?}"
        );

        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().expect("outside");
            std::fs::write(outside.path().join("secret.md"), b"outside").expect("secret");
            std::os::unix::fs::symlink(outside.path().join("secret.md"), root.join("sneaky.md"))
                .expect("link");
            assert!(matches!(
                note_read(&root, "sneaky.md"),
                Err(NoteError::OutsideVault(_))
            ));
        }
    }

    /// AC3/AC4: exact threshold boundaries for the §5.6 size policies.
    #[test]
    fn size_policy_boundaries_are_exact() {
        assert_eq!(classify_size(SOURCE_ONLY_BYTES), SizePolicy::Normal);
        assert_eq!(classify_size(SOURCE_ONLY_BYTES + 1), SizePolicy::SourceOnly);
        assert_eq!(classify_size(METADATA_ONLY_BYTES), SizePolicy::SourceOnly);
        assert_eq!(
            classify_size(METADATA_ONLY_BYTES + 1),
            SizePolicy::MetadataOnly
        );
    }

    /// AC3: a >2 MB note reads with the Source-only flag and full content.
    #[test]
    fn large_note_is_source_only_with_content() {
        let body = vec![b'a'; (SOURCE_ONLY_BYTES + 1) as usize];
        let (_dir, root) = vault_with(&[("big.md", body.as_slice())]);
        let doc = note_read(&root, "big.md").expect("read");
        assert_eq!(doc.meta.size_policy, SizePolicy::SourceOnly);
        assert_eq!(doc.content.expect("content present").len(), body.len());
    }

    /// AC4: a >20 MB file is metadata-only — no content, hash still present.
    #[test]
    fn huge_file_is_metadata_only_but_hashed() {
        let body = vec![b'b'; (METADATA_ONLY_BYTES + 1) as usize];
        let (_dir, root) = vault_with(&[("huge.md", body.as_slice())]);
        let doc = note_read(&root, "huge.md").expect("read");
        assert_eq!(doc.meta.size_policy, SizePolicy::MetadataOnly);
        assert!(doc.content.is_none());
        assert_eq!(doc.hash, ContentHash::of(&body));
        assert_eq!(doc.meta.size, body.len() as u64);
    }

    /// AC5: platform placeholder classifiers against fixture flag values.
    #[test]
    fn placeholder_classifiers_match_platform_fixtures() {
        use super::placeholder::*;
        assert!(macos_flags_are_dataless(MACOS_SF_DATALESS));
        assert!(macos_flags_are_dataless(MACOS_SF_DATALESS | 0x1));
        assert!(!macos_flags_are_dataless(0));
        assert!(!macos_flags_are_dataless(0x1));
        assert!(windows_attributes_are_dataless(
            WINDOWS_RECALL_ON_DATA_ACCESS
        ));
        assert!(windows_attributes_are_dataless(
            WINDOWS_RECALL_ON_DATA_ACCESS | 0x20
        ));
        assert!(!windows_attributes_are_dataless(0x20));
    }

    #[test]
    fn non_utf8_notes_are_a_typed_error() {
        let (_dir, root) = vault_with(&[("bad.md", &[0xff, 0xfe, 0x00][..])]);
        assert!(matches!(
            note_read(&root, "bad.md"),
            Err(NoteError::NotUtf8(_))
        ));
    }

    #[test]
    fn missing_and_non_file_paths_are_typed_errors() {
        let (_dir, root) = vault_with(&[("sub/inner.md", b"x")]);
        assert!(matches!(
            note_read(&root, "missing.md"),
            Err(NoteError::NotFound(_))
        ));
        assert!(matches!(
            note_read(&root, "sub"),
            Err(NoteError::NotAFile(_))
        ));
    }
}
