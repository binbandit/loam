//! Vault opening (§3.1, §5.6): any folder is a vault; opening validates the
//! root, establishes (or reuses) the identity, detects read-only state, and
//! registers the canonical root as the capability boundary every later
//! operation is checked against.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::tree::{self, TreeError, VaultTree};
use super::{Confirmation, IdentityError, VaultId, VaultIdentity};

/// §5.4 `vault_open(path) -> VaultInfo` — id, root, counts, index status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub id: VaultId,
    pub root: PathBuf,
    pub read_only: bool,
    /// True when the id was generated for this session only because the vault
    /// is read-only (or unconfirmed) and the identity file could not be
    /// persisted. Never written to disk.
    pub transient_identity: bool,
    pub counts: VaultCounts,
    /// Index status is `NotIndexed` until the SQLite index lands (E04).
    pub index_status: IndexStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultCounts {
    pub notes: usize,
    pub folders: usize,
    pub attachments: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IndexStatus {
    NotIndexed,
}

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error("vault root does not exist or is not a folder: {0}")]
    NotAFolder(PathBuf),
    #[error("the user declined to use this folder as a vault")]
    Declined,
    #[error(transparent)]
    Identity(#[from] IdentityError),
    #[error(transparent)]
    Tree(#[from] TreeError),
    #[error("failed to open the vault: {0}")]
    Io(#[from] std::io::Error),
}

/// An opened vault: canonical root + identity + read-only state. The canonical
/// root is the capability boundary — all core file operations must resolve
/// inside it.
#[derive(Debug, Clone)]
pub struct Vault {
    pub info: VaultInfo,
    pub tree: VaultTree,
}

/// Open `path` as a vault (§5.4). Identity is persisted only on explicit
/// confirmation and only when the folder is writable; read-only folders open
/// in read-only mode with a session-transient id (§5.6).
pub fn vault_open(path: &Path, confirmation: Confirmation) -> Result<Vault, OpenError> {
    if !path.is_dir() {
        return Err(OpenError::NotAFolder(path.to_path_buf()));
    }
    let root = path.canonicalize()?;
    let read_only = is_read_only(&root);

    let (id, transient_identity) = match VaultIdentity::load(&root)? {
        Some(existing) => (existing.id, false),
        None if read_only => (VaultId::transient(), true),
        None => match VaultIdentity::establish(&root, confirmation)? {
            Some(created) => (created.id, false),
            None => return Err(OpenError::Declined),
        },
    };

    let tree = tree::enumerate(&root)?;
    Ok(Vault {
        info: VaultInfo {
            id,
            root,
            read_only,
            transient_identity,
            counts: tree.counts(),
            index_status: IndexStatus::NotIndexed,
        },
        tree,
    })
}

/// Read-only detection by authoritative probe: try to create (and immediately
/// remove) a hidden temp file. Permission metadata is unreliable across
/// platforms and network mounts; the probe answers the only question that
/// matters — can Loam write here.
fn is_read_only(root: &Path) -> bool {
    let probe = root.join(format!(".loam-write-probe-{}", std::process::id()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            std::fs::remove_file(&probe).ok();
            false
        }
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AC1: any readable folder opens after confirmation, with §5.4 fields.
    #[test]
    fn readable_folder_opens_after_confirmation() {
        let dir = tempfile::tempdir().expect("vault");
        std::fs::write(dir.path().join("Note.md"), "# hi\n").expect("note");
        std::fs::create_dir(dir.path().join("sub")).expect("sub");
        std::fs::write(dir.path().join("img.png"), [0x89]).expect("attachment");

        let vault = vault_open(dir.path(), Confirmation::Confirmed).expect("opens");
        assert!(!vault.info.read_only);
        assert!(!vault.info.transient_identity);
        assert_eq!(vault.info.counts.notes, 1);
        assert_eq!(vault.info.counts.folders, 1);
        assert_eq!(vault.info.counts.attachments, 1);
        assert_eq!(vault.info.index_status, IndexStatus::NotIndexed);
        // Reopening reuses the persisted identity.
        let again = vault_open(dir.path(), Confirmation::Cancelled).expect("reopens");
        assert_eq!(again.info.id, vault.info.id);
    }

    /// Declining a fresh folder opens nothing and writes nothing.
    #[test]
    fn declined_folder_is_not_opened() {
        let dir = tempfile::tempdir().expect("vault");
        assert!(matches!(
            vault_open(dir.path(), Confirmation::Cancelled),
            Err(OpenError::Declined)
        ));
        assert_eq!(std::fs::read_dir(dir.path()).expect("readable").count(), 0);
    }

    /// AC4: a read-only folder opens with the read-only flag, a transient id,
    /// and no identity write attempt.
    #[cfg(unix)]
    #[test]
    fn read_only_folder_opens_read_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("vault");
        std::fs::write(dir.path().join("Note.md"), "# hi\n").expect("note");
        let mut perms = std::fs::metadata(dir.path()).expect("meta").permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(dir.path(), perms.clone()).expect("chmod");

        let vault = vault_open(dir.path(), Confirmation::Confirmed).expect("opens read-only");
        assert!(vault.info.read_only);
        assert!(vault.info.transient_identity);
        assert!(
            !VaultIdentity::file_path(dir.path()).exists(),
            "no identity write into a read-only vault"
        );

        perms.set_mode(0o755);
        std::fs::set_permissions(dir.path(), perms).expect("restore");
    }

    #[test]
    fn missing_path_is_rejected() {
        assert!(matches!(
            vault_open(Path::new("/definitely/missing"), Confirmation::Confirmed),
            Err(OpenError::NotAFolder(_))
        ));
    }
}
