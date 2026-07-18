//! Thin Tauri 2 shell for Loam. All engine logic lives in `loam-core`, which
//! exposes no Tauri types; the webview talks to the shell only through typed
//! IPC commands (E06).

/// Start the desktop shell.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            panic!("failed to start the {} shell: {error}", loam_core::APP_NAME)
        });
}
