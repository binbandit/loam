//! Thin Tauri 2 shell for Loam. All engine logic lives in `loam-core`, which
//! exposes no Tauri types; the webview talks to the shell only through typed
//! IPC commands (E06).

pub mod commands;
pub mod events;
pub mod menu;
pub mod routes;
pub mod windows;

use tauri::Manager as _;

/// The embedded app context (config, assets, capability ACL). Single macro
/// call site: the macro embeds the macOS Info.plist and collides with itself
/// if expanded twice in one crate.
fn context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

/// Map a window-routing failure into the stable §5.4 error contract.
fn map_route_error(error: routes::OpenError) -> loam_core::ipc::LoamError {
    use loam_core::ipc::LoamError;
    match error {
        routes::OpenError::NotAccessible | routes::OpenError::NotAFolder => LoamError::NotAVault,
        other => LoamError::Internal {
            detail: other.to_string(),
        },
    }
}

/// Open (or focus) the window for the vault at `path`, core-open it, and
/// register its capability root (§5.4 `vault_open -> VaultInfo`). Every
/// entry route (picker, drag-drop, CLI, `loam://`) funnels through the same
/// normalizer (LOA-48).
#[tauri::command]
#[specta::specta]
fn vault_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<loam_core::ipc::VaultInfo, loam_core::ipc::LoamError> {
    let window = routes::open_path_input(&app, &path).map_err(map_route_error)?;
    let registry = app.state::<commands::VaultRegistry>();
    let info = commands::open_and_register(&registry, &window.root)?;
    // Event lifetime follows the vault window (LOA-60): starting replaces
    // any previous bridge, so reopening never double-subscribes.
    let key = windows::vault_key(&window.root.canonicalize().unwrap_or(window.root.clone()));
    if let Some(label) = windows::label_for_key(&app, &key) {
        let bridges = app.state::<events::EventBridges>();
        let canonical = window.root.canonicalize().unwrap_or(window.root.clone());
        events::start_bridge(&app, &bridges, &info.id, &canonical, &label)?;
    }
    Ok(info)
}

/// Native folder picker entry (§3.1). The dialog plugin is driven from Rust —
/// the webview holds no dialog permission and invokes only this typed command.
/// `None` means the user cancelled.
#[tauri::command]
#[specta::specta]
async fn vault_pick_and_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<loam_core::ipc::VaultInfo>, loam_core::ipc::LoamError> {
    use tauri_plugin_dialog::DialogExt;
    match app.dialog().file().blocking_pick_folder() {
        Some(folder) => {
            let path = folder
                .into_path()
                .map_err(|_| map_route_error(routes::OpenError::NotAccessible))?;
            vault_open(app, path.to_string_lossy().into_owned()).map(Some)
        }
        None => Ok(None),
    }
}

/// The single source of truth for the typed IPC surface (LOA-63): commands
/// registered here are exactly what the generated TypeScript client exposes.
/// Event payload types ride along via `.typ()` so the §5.4 envelopes export
/// even though event emission is manual (LOA-60 bridge). A macro because the
/// `collect_commands!` turbofish cannot borrow an outer generic parameter.
macro_rules! specta_builder {
    ($runtime:ty) => {{
        use loam_core::ipc;
        tauri_specta::Builder::<$runtime>::new()
            .commands(tauri_specta::collect_commands![
                $crate::vault_open::<$runtime>,
                $crate::vault_pick_and_open::<$runtime>,
                $crate::commands::note_read,
                $crate::commands::note_write::<$runtime>,
                $crate::commands::note_create,
                $crate::commands::folder_create,
                $crate::commands::note_rename,
                $crate::commands::note_duplicate,
                $crate::commands::note_trash,
                $crate::commands::vault_tree,
                $crate::commands::workspace_read::<$runtime>,
                $crate::commands::workspace_write::<$runtime>,
                $crate::commands::workspace_quarantine::<$runtime>,
            ])
            .typ::<ipc::EventEnvelope<ipc::VaultEvent>>()
            .typ::<ipc::EventEnvelope<ipc::IndexProgress>>()
            .typ::<ipc::EventEnvelope<ipc::ConflictPayload>>()
    }};
}

/// The export-facing builder (generation + drift tests).
pub fn export_builder() -> tauri_specta::Builder<tauri::Wry> {
    specta_builder!(tauri::Wry)
}

/// Shared shell setup: state, plugins, and command surface. Applied to the
/// real builder in `run()` and to the mock-runtime builder in tests, so both
/// register the exact same invoke surface (and the same ACL denials). The
/// invoke handler always comes from `specta_builder!` at the call site (it
/// must instantiate with a concrete runtime) — the generated client and the
/// registered surface cannot drift.
fn configure<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    invoke_handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> tauri::Builder<R> {
    builder
        .manage(windows::VaultWindows::default())
        .manage(commands::VaultRegistry::default())
        .manage(events::EventBridges::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(invoke_handler)
}

/// Start the desktop shell.
pub fn run() {
    configure(
        tauri::Builder::default(),
        specta_builder!(tauri::Wry).invoke_handler(),
    )
    // Menus are attached only here: native menu construction must run on
    // the main thread, which tests (mock runtime, worker threads) are not.
    .menu(menu::build)
    .on_menu_event(|app, event| {
        // "Open vault…" is handled natively (the picker lives Rust-side);
        // every other row forwards its command ID to the frontend.
        if event.id().as_ref() == "file.open-vault" {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = vault_pick_and_open(handle).await {
                    eprintln!("open vault failed: {error}");
                }
            });
        } else {
            menu::forward_event(app, event.id().as_ref());
        }
    })
    // Drag-dropping a folder onto the first-run window opens it (§3.1).
    .on_window_event(|window, event| {
        if window.label() != windows::FIRST_RUN_LABEL {
            return;
        }
        if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
            for path in paths {
                if let Err(error) =
                    routes::open_path_input(window.app_handle(), &path.to_string_lossy())
                {
                    eprintln!("dropped path was not opened: {error}");
                }
            }
        }
    })
    .setup(|app| {
        // loam://open deep links (registered scheme; handled Rust-side).
        use tauri_plugin_deep_link::DeepLinkExt;
        // Dev-time scheme registration is best-effort: on bare CI runners
        // (no xdg/registry desktop integration) it fails with ENOENT, and
        // a scheme miss must never prevent the app from starting. Caught
        // by the native smoke harness: the setup-hook `?` killed the app.
        #[cfg(any(target_os = "linux", windows))]
        if let Err(error) = app.deep_link().register_all() {
            eprintln!("loam:// scheme registration failed (non-fatal): {error}");
        }
        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
            for url in event.urls() {
                if let Err(error) = routes::open_uri_input(&handle, url.as_str()) {
                    eprintln!("deep link rejected: {error}");
                }
            }
        });
        // Initial CLI path argument.
        if let Some(path) = routes::cli_path_argument(std::env::args())
            && let Err(error) = routes::open_path_input(app.handle(), &path)
        {
            eprintln!("CLI vault path was not opened: {error}");
        }
        Ok(())
    })
    .build(context())
    .unwrap_or_else(|error| panic!("failed to start the {} shell: {error}", loam_core::APP_NAME))
    .run(|app, event| {
        // macOS dock reopen with no windows: recreate the first-run window
        // (`RunEvent::Reopen` only exists on macOS). All other close/quit
        // routing is the deterministic platform default — the app exits
        // with its last window on every platform.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            windows::reopen_first_run(app).ok();
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}

/// Shared mock-runtime harness for command tests: real generated context,
/// real ACL, real invoke pipeline.
#[cfg(test)]
pub(crate) mod test_support {
    use tauri::WebviewWindow;
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
    use tauri::webview::InvokeRequest;

    pub(crate) fn mock_app() -> tauri::App<MockRuntime> {
        crate::configure(
            mock_builder(),
            specta_builder!(MockRuntime).invoke_handler(),
        )
        .build(crate::context())
        .expect("mock app with the real context should build")
    }

    pub(crate) fn main_webview_on(app: &tauri::App<MockRuntime>) -> WebviewWindow<MockRuntime> {
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
            .build()
            .expect("mock webview window builds")
    }

    pub(crate) fn invoke(
        webview: &WebviewWindow<MockRuntime>,
        cmd: &str,
        body: serde_json::Value,
    ) -> Result<InvokeResponseBody, serde_json::Value> {
        let local_url = webview.url().expect("mock webview has a URL");
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: local_url,
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }
}

// Runtime verification of the §5.10 trust boundary (LOA-36): these tests drive
// the real IPC invoke pipeline (mock runtime, REAL generated context, so the
// shipped capability ACL is what gets enforced) — the exact bridge a webview
// script would use.
#[cfg(test)]
mod tests {
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response};
    use tauri::webview::InvokeRequest;
    use tauri::{Manager, WebviewWindow};

    fn mock_app() -> tauri::App<MockRuntime> {
        crate::test_support::mock_app()
    }

    fn main_webview_on(app: &tauri::App<MockRuntime>) -> WebviewWindow<MockRuntime> {
        // Label "main" matches capabilities/default.json `windows`, so the
        // shipped ACL governs this webview exactly as in production.
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
            .build()
            .expect("mock webview window builds")
    }

    fn main_webview() -> WebviewWindow<MockRuntime> {
        main_webview_on(&mock_app())
    }

    fn invoke(
        webview: &WebviewWindow<MockRuntime>,
        cmd: &str,
        body: serde_json::Value,
    ) -> Result<InvokeResponseBody, serde_json::Value> {
        let local_url = webview.url().expect("mock webview has a URL");
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: local_url,
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }

    /// AC1: there is no filesystem bridge — a webview attempting to read any
    /// path (vault-external or otherwise) is rejected at the invoke layer.
    #[test]
    fn webview_cannot_read_files_over_ipc() {
        let webview = main_webview();
        let denied = invoke(
            &webview,
            "plugin:fs|read_text_file",
            serde_json::json!({ "path": "/etc/passwd" }),
        );
        assert!(
            denied.is_err(),
            "fs plugin must not be reachable: {denied:?}"
        );
    }

    /// AC2: no invoke can execute a process.
    #[test]
    fn webview_cannot_execute_processes_over_ipc() {
        let webview = main_webview();
        for cmd in [
            "plugin:shell|execute",
            "plugin:shell|open",
            "plugin:process|exit",
        ] {
            let denied = invoke(&webview, cmd, serde_json::json!({}));
            assert!(denied.is_err(), "{cmd} must not be reachable: {denied:?}");
        }
    }

    /// Core plugins that ship but are NOT granted in capabilities/default.json
    /// are denied by the ACL — the grants list is enforced, not decorative.
    #[test]
    fn ungranted_core_plugins_are_denied() {
        let webview = main_webview();
        let denied = invoke(&webview, "plugin:image|new", serde_json::json!({}));
        assert!(denied.is_err(), "core:image is not granted: {denied:?}");
        // Registered Rust-side plugins (dialog, deep-link) are still denied to
        // the webview: no capability grants them.
        for cmd in ["plugin:dialog|open", "plugin:deep-link|is_registered"] {
            let denied = invoke(&webview, cmd, serde_json::json!({}));
            assert!(denied.is_err(), "{cmd} must be ACL-denied: {denied:?}");
        }
    }

    /// LOA-41 AC1/AC2/AC4/AC5: vault window lifecycle through the real
    /// `vault_open` command surface.
    #[test]
    fn vault_windows_open_focus_and_stay_independent() {
        let mock = mock_app();
        let webview = main_webview_on(&mock);
        let app = webview.app_handle();
        let vault_a = tempfile::tempdir().expect("vault a");
        let vault_b = tempfile::tempdir().expect("vault b");
        let entries_before = std::fs::read_dir(vault_a.path()).expect("readable").count();

        // Window semantics live in the route layer; the `vault_open` command
        // wraps this and additionally returns the §5.4 contract VaultInfo
        // (covered by the LOA-57 command tests).
        let open = |path: &std::path::Path| {
            crate::routes::open_path_input(app, &path.to_string_lossy())
                .expect("vault_open route succeeds")
        };

        // AC1: two vaults, two separate windows.
        let first = open(vault_a.path());
        assert!(!first.focused_existing);
        let second = open(vault_b.path());
        assert!(!second.focused_existing);
        assert_ne!(first.id, second.id);
        assert_eq!(crate::windows::open_vault_count(app), 2);

        // AC2: reopening vault A focuses the existing window, creates nothing.
        let again = open(vault_a.path());
        assert!(again.focused_existing);
        assert_eq!(again.id, first.id);
        assert_eq!(crate::windows::open_vault_count(app), 2);

        // AC4: closing vault A's window leaves vault B registered and its
        // window focusable. The mock runtime delivers no window events, so the
        // Destroyed cleanup (wired in open_or_focus) is invoked directly.
        assert_eq!(crate::windows::registered_vault_count(app), 2);
        let key_a = crate::windows::vault_key(&vault_a.path().canonicalize().expect("canon a"));
        app.get_webview_window("vault-1")
            .expect("window a")
            .destroy()
            .expect("destroy a");
        crate::windows::on_vault_window_destroyed(app, &key_a);
        assert_eq!(crate::windows::registered_vault_count(app), 1);
        app.get_webview_window("vault-2")
            .expect("window b survives a's close")
            .set_focus()
            .expect("focus b");

        // Reopening vault A after its close creates a fresh window, not a
        // zombie focus.
        let reopened = open(vault_a.path());
        assert!(!reopened.focused_existing);
        assert_eq!(crate::windows::registered_vault_count(app), 2);

        // AC5: nothing was ever written into the vault itself.
        let entries_after = std::fs::read_dir(vault_a.path()).expect("readable").count();
        assert_eq!(entries_before, entries_after);
    }

    /// Invalid paths are rejected before any window is created.
    #[test]
    fn vault_open_rejects_missing_and_non_directory_paths() {
        let webview = main_webview();
        let app = webview.app_handle();
        let missing = crate::vault_open(app.clone(), "/definitely/not/a/vault".into());
        assert!(missing.is_err());
        let file = tempfile::NamedTempFile::new().expect("temp file");
        let not_dir = crate::vault_open(app.clone(), file.path().to_string_lossy().into_owned());
        assert!(not_dir.is_err());
        assert_eq!(crate::windows::open_vault_count(app), 0);
    }

    /// Positive control: a command covered by the granted permission set works,
    /// proving the failures above are real denials, not a broken harness.
    #[test]
    fn granted_core_commands_resolve() {
        let webview = main_webview();
        let allowed = invoke(&webview, "plugin:app|version", serde_json::json!({}));
        assert!(
            allowed.is_ok(),
            "core:app:default grants app version: {allowed:?}"
        );
    }
}
