//! Per-device data layout (§5.5): every disposable artifact lives under the OS
//! app-data directory keyed by vault id — never inside the vault, so caches
//! never pollute sync or Git diffs and `.loam/cache` can never exist.

use std::path::{Path, PathBuf};

use super::VaultId;

/// Per-device root for Loam's disposable data. The application shell injects
/// the platform app-data directory (e.g. Tauri's `app_data_dir()`); tests
/// inject a temp dir. Keeping the root injected keeps `loam-core` pure.
#[derive(Debug, Clone)]
pub struct DeviceLayout {
    app_data_root: PathBuf,
}

/// Resolved per-vault device paths (§5.5): all rebuildable, all disposable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevicePaths {
    /// SQLite index — disposable, rebuilt on schema bump or corruption (D5).
    pub index_db: PathBuf,
    /// tantivy full-text index directory (D6).
    pub search_dir: PathBuf,
    /// Window/tab layout for this device.
    pub workspace_json: PathBuf,
    /// File-recovery snapshots (§3.1), stored outside the vault.
    pub history_dir: PathBuf,
    /// Graph node-position cache (§3.9).
    pub graph_cache_json: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum LayoutError {
    #[error("device data root must never be inside a vault: {root} is under {vault}")]
    RootInsideVault { root: PathBuf, vault: PathBuf },
}

impl DeviceLayout {
    pub fn new(app_data_root: impl Into<PathBuf>) -> Self {
        Self {
            app_data_root: app_data_root.into(),
        }
    }

    /// Per-vault directory under the device root.
    pub fn vault_dir(&self, id: VaultId) -> PathBuf {
        self.app_data_root.join("vaults").join(id.to_string())
    }

    /// Resolve every §5.5 device path for a vault, rejecting any layout whose
    /// root would place caches inside the vault itself.
    pub fn paths_for(&self, id: VaultId, vault_root: &Path) -> Result<DevicePaths, LayoutError> {
        if self.app_data_root.starts_with(vault_root) {
            return Err(LayoutError::RootInsideVault {
                root: self.app_data_root.clone(),
                vault: vault_root.to_path_buf(),
            });
        }
        let base = self.vault_dir(id);
        Ok(DevicePaths {
            index_db: base.join("index.db"),
            search_dir: base.join("search"),
            workspace_json: base.join("workspace.json"),
            history_dir: base.join("history"),
            graph_cache_json: base.join("graph-cache.json"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Confirmation, VaultIdentity};
    use super::*;

    /// AC4: every device path resolves under the app-data root and outside the
    /// vault.
    #[test]
    fn device_paths_resolve_outside_the_vault() {
        let vault = tempfile::tempdir().expect("vault");
        let app_data = tempfile::tempdir().expect("app data");
        let identity = VaultIdentity::establish(vault.path(), Confirmation::Confirmed)
            .expect("establish")
            .expect("created");

        let layout = DeviceLayout::new(app_data.path());
        let paths = layout.paths_for(identity.id, vault.path()).expect("layout");

        let all = [
            &paths.index_db,
            &paths.search_dir,
            &paths.workspace_json,
            &paths.history_dir,
            &paths.graph_cache_json,
        ];
        for path in all {
            assert!(
                path.starts_with(app_data.path()),
                "{path:?} must live under the device root"
            );
            assert!(
                !path.starts_with(vault.path()),
                "{path:?} must never live inside the vault"
            );
            assert!(
                path.to_string_lossy().contains(&identity.id.to_string()),
                "{path:?} must be keyed by vault id"
            );
        }
        assert!(paths.index_db.ends_with("index.db"));
        assert!(paths.search_dir.ends_with("search"));
        assert!(paths.workspace_json.ends_with("workspace.json"));
        assert!(paths.history_dir.ends_with("history"));
        assert!(paths.graph_cache_json.ends_with("graph-cache.json"));
    }

    /// A device root inside the vault is rejected outright.
    #[test]
    fn root_inside_vault_is_rejected() {
        let vault = tempfile::tempdir().expect("vault");
        let identity = VaultIdentity::establish(vault.path(), Confirmation::Confirmed)
            .expect("establish")
            .expect("created");

        for inside in [vault.path().to_path_buf(), vault.path().join(".loam/cache")] {
            let layout = DeviceLayout::new(&inside);
            assert!(matches!(
                layout.paths_for(identity.id, vault.path()),
                Err(LayoutError::RootInsideVault { .. })
            ));
        }
    }

    /// AC5: establishing identity + resolving the full layout leaves the vault
    /// with only `.loam/vault.json` — `.loam/cache` can never appear.
    #[test]
    fn layout_resolution_never_touches_the_vault() {
        let vault = tempfile::tempdir().expect("vault");
        let app_data = tempfile::tempdir().expect("app data");
        let identity = VaultIdentity::establish(vault.path(), Confirmation::Confirmed)
            .expect("establish")
            .expect("created");
        let layout = DeviceLayout::new(app_data.path());
        let _paths = layout.paths_for(identity.id, vault.path()).expect("layout");

        assert!(
            !vault.path().join(".loam/cache").exists(),
            ".loam/cache must never exist (§5.5)"
        );
        let loam_entries: Vec<_> = std::fs::read_dir(vault.path().join(".loam"))
            .expect("readable")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(loam_entries, vec!["vault.json".to_string()]);
    }
}
