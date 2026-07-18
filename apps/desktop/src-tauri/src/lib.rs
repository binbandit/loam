//! Thin Tauri 2 shell for Loam. All engine logic lives in `loam-core`, which
//! exposes no Tauri types; the webview talks to the shell only through typed
//! IPC commands (E06).

/// The embedded app context (config, assets, capability ACL). Single macro
/// call site: the macro embeds the macOS Info.plist and collides with itself
/// if expanded twice in one crate.
fn context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

/// Start the desktop shell.
pub fn run() {
    tauri::Builder::default()
        .run(context())
        .unwrap_or_else(|error| {
            panic!("failed to start the {} shell: {error}", loam_core::APP_NAME)
        });
}

// Runtime verification of the §5.10 trust boundary (LOA-36): these tests drive
// the real IPC invoke pipeline (mock runtime, REAL generated context, so the
// shipped capability ACL is what gets enforced) — the exact bridge a webview
// script would use.
#[cfg(test)]
mod tests {
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
    use tauri::webview::InvokeRequest;
    use tauri::WebviewWindow;

    fn main_webview() -> WebviewWindow<MockRuntime> {
        let app = mock_builder()
            .build(crate::context())
            .expect("mock app with the real context should build");
        // Label "main" matches capabilities/default.json `windows`, so the
        // shipped ACL governs this webview exactly as in production.
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .expect("mock webview window builds")
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
