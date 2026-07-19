//! `.loam/vault.json` — the single file Loam creates in a vault unprompted,
//! and only after explicit confirmation (§5.5).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

/// Stable, locally generated vault identifier (UUID v4; no network involved).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VaultId(Uuid);

impl VaultId {
    fn generate() -> Self {
        Self(Uuid::new_v4())
    }

    /// Session-only id for vaults whose identity cannot be persisted (e.g.
    /// read-only folders). Never written to disk.
    pub(crate) fn transient() -> Self {
        Self::generate()
    }
}

impl std::fmt::Display for VaultId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// Contents of `.loam/vault.json`: `{ id: uuid, createdAt }` per §5.5.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultIdentity {
    pub id: VaultId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// The user's explicit decision on "use this folder as a vault". Cancelling is
/// a first-class value so "writes nothing" is enforced by construction, not by
/// callers remembering to skip a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confirmation {
    Confirmed,
    Cancelled,
}

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("vault root does not exist or is not a folder: {0}")]
    NotAFolder(PathBuf),
    #[error("`.loam/vault.json` exists but could not be parsed; refusing to overwrite it: {0}")]
    Corrupt(#[source] serde_json::Error),
    #[error("failed to read or write the vault identity: {0}")]
    Io(#[from] std::io::Error),
}

const LOAM_DIR: &str = ".loam";
const IDENTITY_FILE: &str = "vault.json";

impl VaultIdentity {
    /// Path of the identity file for a vault root.
    pub fn file_path(vault_root: &Path) -> PathBuf {
        vault_root.join(LOAM_DIR).join(IDENTITY_FILE)
    }

    /// Load an existing identity, if any. Never writes. A present-but-corrupt
    /// identity is an error, not a silent regeneration — the id keys per-device
    /// caches, and §5.5 treats the vault's files as truth.
    pub fn load(vault_root: &Path) -> Result<Option<Self>, IdentityError> {
        if !vault_root.is_dir() {
            return Err(IdentityError::NotAFolder(vault_root.to_path_buf()));
        }
        let path = Self::file_path(vault_root);
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let identity = serde_json::from_str(&raw).map_err(IdentityError::Corrupt)?;
        Ok(Some(identity))
    }

    /// Establish the vault identity: reuse an existing one (AC1), or — only on
    /// explicit confirmation — atomically create `.loam/vault.json` (AC2).
    /// Cancellation writes nothing, not even `.loam/` (AC3), and returns
    /// `Ok(None)`.
    pub fn establish(
        vault_root: &Path,
        confirmation: Confirmation,
    ) -> Result<Option<Self>, IdentityError> {
        if let Some(existing) = Self::load(vault_root)? {
            return Ok(Some(existing));
        }
        if confirmation == Confirmation::Cancelled {
            return Ok(None);
        }

        let identity = Self {
            id: VaultId::generate(),
            created_at: OffsetDateTime::now_utc(),
        };
        let json =
            serde_json::to_string_pretty(&identity).expect("identity always serializes") + "\n";

        // Minimal atomic write: same-directory tempfile then rename, so a
        // crash never leaves a partial identity. The general §5.6 writer (with
        // fsync discipline) arrives in LOA-28 and this will adopt it.
        let dir = vault_root.join(LOAM_DIR);
        fs::create_dir_all(&dir)?;
        let temp = dir.join(format!(".{IDENTITY_FILE}.{}.tmp", std::process::id()));
        fs::write(&temp, json)?;
        match fs::rename(&temp, Self::file_path(vault_root)) {
            Ok(()) => Ok(Some(identity)),
            Err(error) => {
                fs::remove_file(&temp).ok();
                Err(error.into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp vault")
    }

    fn entries(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = walk(root)
            .into_iter()
            .map(|p| {
                p.strip_prefix(root)
                    .expect("under root")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        names.sort();
        names
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in fs::read_dir(dir).expect("readable") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                out.push(path.clone());
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
        out
    }

    /// AC3: cancellation writes nothing at all — not even `.loam/`.
    #[test]
    fn cancelled_confirmation_writes_nothing() {
        let vault = vault();
        let result = VaultIdentity::establish(vault.path(), Confirmation::Cancelled)
            .expect("cancel is not an error");
        assert!(result.is_none());
        assert!(entries(vault.path()).is_empty(), "vault must be untouched");
    }

    /// AC2 + AC5: first confirmation creates exactly one file — the identity —
    /// with no stray temp files and no `.loam/cache`.
    #[test]
    fn first_confirmation_creates_exactly_the_identity_file() {
        let vault = vault();
        let identity = VaultIdentity::establish(vault.path(), Confirmation::Confirmed)
            .expect("establish")
            .expect("created");
        assert_eq!(
            entries(vault.path()),
            vec![".loam".to_string(), ".loam/vault.json".to_string()],
            "exactly the .loam dir and identity file"
        );
        let raw = fs::read_to_string(VaultIdentity::file_path(vault.path())).expect("readable");
        assert!(raw.contains("\"id\""), "camelCase id field");
        assert!(raw.contains("\"createdAt\""), "camelCase createdAt field");
        let parsed: VaultIdentity = serde_json::from_str(&raw).expect("valid json");
        assert_eq!(parsed, identity);
    }

    /// AC1: an existing identity is reused byte-for-byte, never regenerated.
    #[test]
    fn existing_identity_is_reused() {
        let vault = vault();
        let first = VaultIdentity::establish(vault.path(), Confirmation::Confirmed)
            .expect("establish")
            .expect("created");
        let bytes_before =
            fs::read(VaultIdentity::file_path(vault.path())).expect("identity bytes");

        let loaded = VaultIdentity::load(vault.path())
            .expect("load")
            .expect("present");
        assert_eq!(loaded.id, first.id);

        // Re-establishing (with either decision) reuses and never rewrites.
        for confirmation in [Confirmation::Confirmed, Confirmation::Cancelled] {
            let again = VaultIdentity::establish(vault.path(), confirmation)
                .expect("re-establish")
                .expect("still present");
            assert_eq!(again.id, first.id);
        }
        let bytes_after = fs::read(VaultIdentity::file_path(vault.path())).expect("identity bytes");
        assert_eq!(bytes_before, bytes_after, "identity file must be untouched");
    }

    /// A corrupt identity is a hard error — never silently regenerated.
    #[test]
    fn corrupt_identity_is_an_error_not_a_rewrite() {
        let vault = vault();
        fs::create_dir_all(vault.path().join(".loam")).expect("mkdir");
        fs::write(VaultIdentity::file_path(vault.path()), "{ not json").expect("write");

        assert!(matches!(
            VaultIdentity::load(vault.path()),
            Err(IdentityError::Corrupt(_))
        ));
        assert!(matches!(
            VaultIdentity::establish(vault.path(), Confirmation::Confirmed),
            Err(IdentityError::Corrupt(_))
        ));
        let raw = fs::read_to_string(VaultIdentity::file_path(vault.path())).expect("readable");
        assert_eq!(raw, "{ not json", "corrupt file must be left untouched");
    }

    /// Round-trip of the documented §5.5 shape.
    #[test]
    fn identity_round_trips_the_documented_shape() {
        let json = r#"{ "id": "6f2b1e04-9c1c-4f8e-9a2e-3d3f8a1b2c4d", "createdAt": "2026-07-19T00:00:00Z" }"#;
        let identity: VaultIdentity = serde_json::from_str(json).expect("documented shape parses");
        assert_eq!(
            identity.id.to_string(),
            "6f2b1e04-9c1c-4f8e-9a2e-3d3f8a1b2c4d"
        );
        let out = serde_json::to_string(&identity).expect("serializes");
        assert!(out.contains("createdAt"));
    }

    #[test]
    fn missing_root_is_reported() {
        assert!(matches!(
            VaultIdentity::load(Path::new("/definitely/missing/vault")),
            Err(IdentityError::NotAFolder(_))
        ));
    }
}
