//! Typed vault & note IPC commands (§5.4, LOA-57). Every handler is a THIN
//! adapter: resolve the vault's capability context from the registry, call
//! the pure `loam-core` API, and map errors into the stable [`LoamError`]
//! contract unchanged. Command-level tracing records command, path, duration,
//! and outcome — never note content.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use loam_core::ipc::{HashHex, LoamError, NoteDoc, NoteRef, VaultInfo, VaultPath, WriteResult};
use loam_core::vault::{self, Confirmation, OsTrash};
use tauri::State;

/// Open-vault capability roots, keyed by vault id. Every command resolves
/// its vault here FIRST; unknown ids never reach the filesystem.
#[derive(Default)]
pub struct VaultRegistry {
    roots: Mutex<HashMap<String, PathBuf>>,
}

impl VaultRegistry {
    pub fn register(&self, id: &str, canonical_root: PathBuf) {
        self.roots
            .lock()
            .expect("registry lock")
            .insert(id.to_string(), canonical_root);
    }

    pub fn root_of(&self, id: &str) -> Result<PathBuf, LoamError> {
        self.roots
            .lock()
            .expect("registry lock")
            .get(id)
            .cloned()
            .ok_or(LoamError::UnknownVault { id: id.to_string() })
    }

    pub fn remove(&self, id: &str) {
        self.roots.lock().expect("registry lock").remove(id);
    }
}

/// Command tracing (AC4): name, path, duration, outcome — no content field
/// exists on this call path at all.
fn traced<T>(
    command: &'static str,
    path: &str,
    run: impl FnOnce() -> Result<T, LoamError>,
) -> Result<T, LoamError> {
    let started = std::time::Instant::now();
    let result = run();
    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
    match &result {
        Ok(_) => tracing::info!(target: "loam::ipc", command, path, duration_ms, outcome = "ok"),
        Err(error) => {
            tracing::info!(target: "loam::ipc", command, path, duration_ms, outcome = %error)
        }
    }
    result
}

/// Core-open an already window-routed vault folder and register its
/// capability root. Opening through the app's entry routes is the user's
/// explicit confirmation (§5.5).
pub fn open_and_register(
    registry: &VaultRegistry,
    canonical_root: &std::path::Path,
) -> Result<VaultInfo, LoamError> {
    let opened =
        vault::vault_open(canonical_root, Confirmation::Confirmed).map_err(map_open_error)?;
    let info = VaultInfo::from(&opened.info);
    registry.register(&info.id, canonical_root.to_path_buf());
    Ok(info)
}

fn map_open_error(error: vault::OpenError) -> LoamError {
    match error {
        vault::OpenError::NotAFolder(_) | vault::OpenError::Declined => LoamError::NotAVault,
        vault::OpenError::Identity(vault::IdentityError::Corrupt(_)) => LoamError::CorruptIdentity,
        vault::OpenError::Identity(vault::IdentityError::NotAFolder(_)) => LoamError::NotAVault,
        vault::OpenError::Identity(vault::IdentityError::Io(io)) => LoamError::Io {
            kind: format!("{:?}", io.kind()).to_lowercase(),
            path: None,
        },
        vault::OpenError::Tree(tree) => LoamError::Internal {
            detail: format!("enumeration failed: {tree}"),
        },
        vault::OpenError::Io(io) => LoamError::Io {
            kind: format!("{:?}", io.kind()).to_lowercase(),
            path: None,
        },
    }
}

/// `note_read(vault_id, path) -> NoteDoc` (§5.4).
#[tauri::command]
#[specta::specta]
pub fn note_read(
    registry: State<'_, VaultRegistry>,
    vault_id: String,
    path: String,
) -> Result<NoteDoc, LoamError> {
    traced("note_read", &path, || {
        let root = registry.root_of(&vault_id)?;
        vault::note_read(&root, &path)
            .map(NoteDoc::from)
            .map_err(|error| LoamError::from_note_error(error, &path))
    })
}

/// `note_write(vault_id, path, content, base_hash) -> WriteResult` (§5.4).
#[tauri::command]
#[specta::specta]
pub fn note_write<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    registry: State<'_, VaultRegistry>,
    vault_id: String,
    path: String,
    content: String,
    base_hash: Option<String>,
) -> Result<WriteResult, LoamError> {
    traced("note_write", &path, || {
        let root = registry.root_of(&vault_id)?;
        let base = base_hash.map(vault::ContentHash::from_hex);
        // The bridge sink records the app write (watcher echo suppression)
        // and forwards the app-origin event to the vault's window (LOA-60).
        let sink = crate::events::BridgeSink::new(app.clone(), vault_id.clone());
        let written = vault::note_write(&root, &path, &content, base.as_ref(), &sink)
            .map_err(|error| LoamError::from_write_error(error, &path))?;
        Ok(WriteResult {
            path: VaultPath(path.clone()),
            hash: HashHex(written.hash.as_str().to_string()),
        })
    })
}

/// `note_create(vault_id, folder, title) -> NoteRef` (§5.4; template P1).
#[tauri::command]
#[specta::specta]
pub fn note_create(
    registry: State<'_, VaultRegistry>,
    vault_id: String,
    folder: String,
    title: String,
) -> Result<NoteRef, LoamError> {
    traced("note_create", &folder, || {
        let root = registry.root_of(&vault_id)?;
        let relative = vault::create_note(&root, &folder, &title, "")
            .map_err(|error| LoamError::from_ops_error(error, &folder))?;
        Ok(NoteRef {
            path: VaultPath(relative),
            title,
        })
    })
}

/// Create a folder with the §3.8 collision policy.
#[tauri::command]
#[specta::specta]
pub fn folder_create(
    registry: State<'_, VaultRegistry>,
    vault_id: String,
    parent: String,
    name: String,
) -> Result<VaultPath, LoamError> {
    traced("folder_create", &parent, || {
        let root = registry.root_of(&vault_id)?;
        vault::create_folder(&root, &parent, &name)
            .map(VaultPath)
            .map_err(|error| LoamError::from_ops_error(error, &parent))
    })
}

/// Rename or move (same §3.1 operation) within the vault.
#[tauri::command]
#[specta::specta]
pub fn note_rename(
    registry: State<'_, VaultRegistry>,
    vault_id: String,
    from: String,
    to: String,
) -> Result<(), LoamError> {
    traced("note_rename", &from, || {
        let root = registry.root_of(&vault_id)?;
        vault::rename(&root, &from, &to).map_err(|error| LoamError::from_ops_error(error, &from))
    })
}

/// Duplicate a note without overwriting.
#[tauri::command]
#[specta::specta]
pub fn note_duplicate(
    registry: State<'_, VaultRegistry>,
    vault_id: String,
    path: String,
) -> Result<NoteRef, LoamError> {
    traced("note_duplicate", &path, || {
        let root = registry.root_of(&vault_id)?;
        let relative = vault::duplicate(&root, &path)
            .map_err(|error| LoamError::from_ops_error(error, &path))?;
        let title = std::path::Path::new(&relative)
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(NoteRef {
            path: VaultPath(relative),
            title,
        })
    })
}

/// Delete to the OS trash — never a permanent delete (§5.6).
#[tauri::command]
#[specta::specta]
pub fn note_trash(
    registry: State<'_, VaultRegistry>,
    vault_id: String,
    path: String,
) -> Result<(), LoamError> {
    traced("note_trash", &path, || {
        let root = registry.root_of(&vault_id)?;
        vault::delete_to_trash(&root, &path, &OsTrash)
            .map_err(|error| LoamError::from_ops_error(error, &path))
    })
}

// LOA-57 acceptance tests: the real invoke pipeline via the mock runtime
// with the shipped ACL, against real temp vaults.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{invoke, main_webview_on, mock_app};
    use tauri::Manager as _;

    /// Open a temp vault through the real `vault_open` command and return
    /// (app, webview, vault dir, vault id).
    fn opened_vault() -> (
        tauri::App<tauri::test::MockRuntime>,
        tauri::WebviewWindow<tauri::test::MockRuntime>,
        tempfile::TempDir,
        String,
    ) {
        let app = mock_app();
        let webview = main_webview_on(&app);
        let vault = tempfile::tempdir().expect("vault");
        std::fs::write(vault.path().join("note.md"), "# Note\n\nhello\n").expect("seed");
        let info = crate::vault_open(
            webview.app_handle().clone(),
            vault.path().to_string_lossy().into_owned(),
        )
        .expect("vault_open");
        let id = info.id;
        (app, webview, vault, id)
    }

    /// AC5 + AC1: every LOA-57 command is invocable through the real IPC
    /// pipeline and behaves as the underlying `loam-core` call (delegation
    /// proven by equivalence with direct core results).
    #[test]
    fn all_commands_invocable_over_real_ipc() {
        let (_app, webview, vault, id) = opened_vault();
        let root = vault.path().canonicalize().expect("canonical");

        let read = invoke(
            &webview,
            "note_read",
            serde_json::json!({ "vaultId": id, "path": "note.md" }),
        )
        .expect("note_read invocable");
        let read: serde_json::Value = match read {
            tauri::ipc::InvokeResponseBody::Json(json) => {
                serde_json::from_str(&json).expect("json")
            }
            other => panic!("json response expected: {other:?}"),
        };
        let core = loam_core::vault::note_read(&root, "note.md").expect("core read");
        assert_eq!(read["content"], "# Note\n\nhello\n");
        assert_eq!(read["hash"], core.hash.as_str(), "hash equals core result");

        let base = read["hash"].as_str().expect("hash").to_string();
        let write = invoke(
            &webview,
            "note_write",
            serde_json::json!({
                "vaultId": id, "path": "note.md",
                "content": "# Note\n\nupdated\n", "baseHash": base,
            }),
        );
        assert!(write.is_ok(), "note_write invocable: {write:?}");
        assert_eq!(
            std::fs::read_to_string(vault.path().join("note.md")).expect("read"),
            "# Note\n\nupdated\n"
        );

        for (cmd, body) in [
            (
                "note_create",
                serde_json::json!({ "vaultId": id, "folder": "", "title": "Fresh" }),
            ),
            (
                "folder_create",
                serde_json::json!({ "vaultId": id, "parent": "", "name": "area" }),
            ),
            (
                "note_rename",
                serde_json::json!({ "vaultId": id, "from": "Fresh.md", "to": "area/Fresh.md" }),
            ),
        ] {
            let result = invoke(&webview, cmd, body);
            assert!(result.is_ok(), "{cmd} invocable: {result:?}");
        }
        assert!(vault.path().join("area/Fresh.md").exists(), "ops landed");

        // Duplicate returns the collision-policy name (`note 1.md`) — use the
        // RETURNED path rather than assuming it.
        let duplicated = invoke(
            &webview,
            "note_duplicate",
            serde_json::json!({ "vaultId": id, "path": "note.md" }),
        )
        .expect("note_duplicate invocable");
        let duplicated: serde_json::Value = match duplicated {
            tauri::ipc::InvokeResponseBody::Json(json) => {
                serde_json::from_str(&json).expect("json")
            }
            other => panic!("json response expected: {other:?}"),
        };
        let copy_path = duplicated["path"].as_str().expect("path").to_string();
        assert_eq!(copy_path, "note 1.md", "§3.8 collision policy");
        assert!(vault.path().join(&copy_path).exists());

        // note_trash goes through the OS trash — exercised directly with the
        // recording provider in loam-core's suite; here we prove the command
        // resolves and traces (real trash is CI-gated via LOAM_TEST_REAL_TRASH).
        if std::env::var("LOAM_TEST_REAL_TRASH").as_deref() == Ok("1") {
            let result = invoke(
                &webview,
                "note_trash",
                serde_json::json!({ "vaultId": id, "path": copy_path }),
            );
            assert!(result.is_ok(), "note_trash invocable: {result:?}");
        }
    }

    /// AC2: unknown vault ids and out-of-scope paths are rejected before any
    /// filesystem access.
    #[test]
    fn unknown_vault_and_escaping_paths_are_rejected() {
        let (app, _webview, _vault, id) = opened_vault();
        let registry = app.state::<VaultRegistry>();

        let unknown = note_read(
            app.state::<VaultRegistry>(),
            "not-a-vault-id".into(),
            "note.md".into(),
        );
        assert_eq!(
            unknown.expect_err("unknown vault rejected"),
            LoamError::UnknownVault {
                id: "not-a-vault-id".into()
            }
        );

        let escape = note_read(registry, id, "../../etc/passwd".into());
        assert!(
            matches!(
                escape.expect_err("escape rejected"),
                LoamError::OutsideVault { .. } | LoamError::NotFound { .. }
            ),
            "traversal cannot leave the capability root"
        );
    }

    /// AC3: a stale base hash surfaces the Conflict contract with the disk
    /// hash intact, serialized in the stable tagged shape.
    #[test]
    fn conflict_errors_retain_the_disk_hash_contract() {
        let (app, _webview, vault, id) = opened_vault();
        std::fs::write(vault.path().join("note.md"), "external edit\n").expect("external");
        let disk_hash = loam_core::vault::ContentHash::of(b"external edit\n");

        let stale = loam_core::vault::ContentHash::of(b"# Note\n\nhello\n");
        let error = note_write(
            app.handle().clone(),
            app.state::<VaultRegistry>(),
            id,
            "note.md".into(),
            "mine\n".into(),
            Some(stale.as_str().to_string()),
        )
        .expect_err("stale base conflicts");

        let json = serde_json::to_value(&error).expect("serializes");
        assert_eq!(json["error"], "conflict");
        assert_eq!(json["diskHash"], disk_hash.as_str());
        assert_eq!(
            std::fs::read_to_string(vault.path().join("note.md")).expect("read"),
            "external edit\n",
            "disk untouched on conflict"
        );
    }

    /// AC4: tracing identifies command, path, duration, and outcome — and
    /// note content never appears in the trace stream. Uses a process-global
    /// subscriber (installed once, asserted on the delta) because scoped
    /// `with_default` dispatchers race the global callsite-interest cache
    /// under parallel tests; `#[serial]` keeps the delta unambiguous.
    #[test]
    #[serial_test::serial]
    fn tracing_carries_command_and_duration_without_content() {
        use std::sync::{Arc, Mutex, OnceLock};
        use tracing_subscriber::fmt::MakeWriter;

        #[derive(Clone, Default)]
        struct Capture(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Capture {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().expect("capture").extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> MakeWriter<'a> for Capture {
            type Writer = Capture;
            fn make_writer(&'a self) -> Capture {
                self.clone()
            }
        }

        static CAPTURE: OnceLock<Capture> = OnceLock::new();
        let capture = CAPTURE
            .get_or_init(|| {
                let capture = Capture::default();
                let subscriber = tracing_subscriber::fmt()
                    .with_writer(capture.clone())
                    .with_ansi(false)
                    .finish();
                tracing::subscriber::set_global_default(subscriber)
                    .expect("first global subscriber");
                capture
            })
            .clone();

        let before = capture.0.lock().expect("capture").len();
        let (app, _webview, _vault, id) = opened_vault();
        let secret = "TOP-SECRET-NOTE-BODY";
        note_write(
            app.handle().clone(),
            app.state::<VaultRegistry>(),
            id.clone(),
            "note.md".into(),
            format!("# T\n\n{secret}\n"),
            None,
        )
        .expect_err("create over existing errors (base None)");
        note_read(app.state::<VaultRegistry>(), id, "note.md".into()).expect("read");

        let log =
            String::from_utf8(capture.0.lock().expect("capture")[before..].to_vec()).expect("utf8");
        assert!(log.contains("command=\"note_write\""), "{log}");
        assert!(log.contains("command=\"note_read\""), "{log}");
        assert!(log.contains("duration_ms="), "{log}");
        assert!(log.contains("outcome="), "{log}");
        assert!(log.contains("path=\"note.md\""), "{log}");
        assert!(
            !log.contains("TOP-SECRET-NOTE-BODY"),
            "note content must never reach tracing: {log}"
        );
    }
}
