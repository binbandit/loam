//! Native window ↔ vault lifecycle (LOA-41, §3.1 P0: one window per vault).
//!
//! Vault *data* state belongs to `loam-core`; this module owns only native
//! window state, persisted per device under the OS app-data directory (§5.5) —
//! never inside a vault.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

pub const FIRST_RUN_LABEL: &str = "main";
const VAULT_LABEL_PREFIX: &str = "vault-";
const DEFAULT_SIZE: (f64, f64) = (1100.0, 720.0);
const MIN_SIZE: (f64, f64) = (640.0, 480.0);
/// A window is considered reachable if at least this much of it overlaps a
/// monitor (enough to grab the titlebar).
const MIN_VISIBLE_PX: i32 = 64;

/// Registry of open vault windows, managed as Tauri state.
#[derive(Default)]
pub struct VaultWindows {
    inner: Mutex<Registry>,
}

#[derive(Default)]
struct Registry {
    label_by_key: HashMap<String, String>,
    next_id: u64,
}

/// Minimal shell-side vault handle. Replaced by the generated E06 `VaultInfo`
/// (id, counts, index status) once the IPC contract lands.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    /// Stable per-device id derived from the normalized root path.
    pub id: String,
    pub root: PathBuf,
    pub name: String,
    /// True when an already-open window was focused instead of created.
    pub focused_existing: bool,
}

/// Stable duplicate-detection key for a vault root. The caller passes a
/// canonicalized path; case is folded on case-insensitive platforms.
pub fn vault_key(root: &Path) -> String {
    let raw = root.to_string_lossy();
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        raw.to_lowercase()
    } else {
        raw.into_owned()
    }
}

/// Short stable id for state filenames and window labels.
pub fn vault_id(key: &str) -> String {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// Monitor work area in physical pixels: (x, y, width, height).
pub type MonitorRect = (i32, i32, u32, u32);

/// Returns the geometry if enough of the window lands on any monitor to be
/// reachable, otherwise `None` (caller falls back to a centered default).
pub fn clamp_to_monitors(
    geometry: WindowGeometry,
    monitors: &[MonitorRect],
) -> Option<WindowGeometry> {
    let visible = monitors.iter().any(|&(mx, my, mw, mh)| {
        let overlap_x =
            (geometry.x + geometry.width as i32).min(mx + mw as i32) - geometry.x.max(mx);
        let overlap_y =
            (geometry.y + geometry.height as i32).min(my + mh as i32) - geometry.y.max(my);
        overlap_x >= MIN_VISIBLE_PX && overlap_y >= MIN_VISIBLE_PX
    });
    visible.then_some(geometry)
}

/// Per-device state file for one vault window. `state_dir` is the app-data
/// windows directory — never a vault path.
pub fn geometry_file(state_dir: &Path, key: &str) -> PathBuf {
    state_dir.join(format!("{}.json", vault_id(key)))
}

pub fn load_geometry(state_dir: &Path, key: &str) -> Option<WindowGeometry> {
    let raw = std::fs::read_to_string(geometry_file(state_dir, key)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save_geometry(state_dir: &Path, key: &str, geometry: WindowGeometry) -> std::io::Result<()> {
    std::fs::create_dir_all(state_dir)?;
    let json = serde_json::to_string_pretty(&geometry).expect("geometry serializes");
    std::fs::write(geometry_file(state_dir, key), json)
}

fn state_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("windows"))
}

fn capture_geometry<R: Runtime>(window: &WebviewWindow<R>) -> Option<WindowGeometry> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    })
}

fn monitor_rects<R: Runtime>(window: &WebviewWindow<R>) -> Vec<MonitorRect> {
    window
        .available_monitors()
        .map(|monitors| {
            monitors
                .iter()
                .map(|m| {
                    let position = m.position();
                    let size = m.size();
                    (position.x, position.y, size.width, size.height)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Open a window for `root`, or focus the existing one (AC1/AC2). `root` must
/// already be validated + canonicalized by the caller (routes.rs).
pub fn open_or_focus<R: Runtime>(app: &AppHandle<R>, root: &Path) -> tauri::Result<VaultInfo> {
    let key = vault_key(root);
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    let registry = app.state::<VaultWindows>();

    // Fast path: focus the existing window for this vault (AC2).
    if let Some(label) = registry
        .inner
        .lock()
        .expect("registry lock")
        .label_by_key
        .get(&key)
        .cloned()
    {
        if let Some(window) = app.get_webview_window(&label) {
            window.show()?;
            window.unminimize().ok();
            window.set_focus()?;
            return Ok(VaultInfo {
                id: vault_id(&key),
                root: root.to_path_buf(),
                name,
                focused_existing: true,
            });
        }
        // Stale entry (window died without cleanup): fall through and recreate.
        registry
            .inner
            .lock()
            .expect("registry lock")
            .label_by_key
            .remove(&key);
    }

    let label = {
        let mut inner = registry.inner.lock().expect("registry lock");
        inner.next_id += 1;
        // Label scheme leaves room for the P1 multi-window-per-vault flag
        // (vault-<n>-<pane> later) without breaking the capability glob.
        format!("{VAULT_LABEL_PREFIX}{}", inner.next_id)
    };

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title(&name)
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .visible(false);
    // §3.5: overlay titlebar on macOS (native traffic lights over our slim
    // bar); Windows/Linux keep full native decorations.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = builder.build()?;

    // Restore per-device geometry, clamped to the current monitor layout (AC3).
    // Best-effort: a restore failure must never block opening the vault.
    if let Some(saved) = state_dir(app).and_then(|dir| load_geometry(&dir, &key)) {
        if let Some(geometry) = clamp_to_monitors(saved, &monitor_rects(&window)) {
            window
                .set_position(PhysicalPosition::new(geometry.x, geometry.y))
                .ok();
            window
                .set_size(PhysicalSize::new(geometry.width, geometry.height))
                .ok();
            if geometry.maximized {
                window.maximize().ok();
            }
        } else {
            window.center().ok();
        }
    }
    window.show()?;
    window.set_focus()?;

    registry
        .inner
        .lock()
        .expect("registry lock")
        .label_by_key
        .insert(key.clone(), label.clone());

    // Closing this window persists its geometry and unregisters the vault;
    // other vault windows are untouched (AC4).
    let handle = app.clone();
    let event_key = key.clone();
    let event_label = label;
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { .. } => {
            if let (Some(dir), Some(geometry)) = (
                state_dir(&handle),
                handle
                    .get_webview_window(&event_label)
                    .as_ref()
                    .and_then(capture_geometry),
            ) {
                save_geometry(&dir, &event_key, geometry).ok();
            }
        }
        WindowEvent::Destroyed => on_vault_window_destroyed(&handle, &event_key),
        _ => {}
    });

    Ok(VaultInfo {
        id: vault_id(&key),
        root: root.to_path_buf(),
        name,
        focused_existing: false,
    })
}

/// Number of currently open vault windows (test + reopen support).
pub fn open_vault_count<R: Runtime>(app: &AppHandle<R>) -> usize {
    app.webview_windows()
        .keys()
        .filter(|label| label.starts_with(VAULT_LABEL_PREFIX))
        .count()
}

/// Registry cleanup when a vault window is destroyed. Called by the window
/// event handler; public so tests (whose mock runtime delivers no window
/// events) can simulate the event and verify the cleanup contract.
pub fn on_vault_window_destroyed<R: Runtime>(app: &AppHandle<R>, key: &str) {
    if let Some(registry) = app.try_state::<VaultWindows>() {
        registry
            .inner
            .lock()
            .expect("registry lock")
            .label_by_key
            .remove(key);
    }
}

/// Number of vaults tracked in the registry (duplicate-detection source).
pub fn registered_vault_count<R: Runtime>(app: &AppHandle<R>) -> usize {
    app.state::<VaultWindows>()
        .inner
        .lock()
        .expect("registry lock")
        .label_by_key
        .len()
}

/// macOS dock-icon reopen with no windows left: recreate the first-run window.
/// Close/quit routing is otherwise the platform default — closing a vault
/// window never touches other vaults, and the app exits with its last window.
pub fn reopen_first_run<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.webview_windows().is_empty() {
        let builder = WebviewWindowBuilder::new(app, FIRST_RUN_LABEL, WebviewUrl::default())
            .title("Loam")
            .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
            .min_inner_size(MIN_SIZE.0, MIN_SIZE.1);
        #[cfg(target_os = "macos")]
        let builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
        builder.build()?;
    } else if let Some(window) = app.webview_windows().values().next() {
        window.set_focus()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: MonitorRect = (0, 0, 1512, 982);
    const EXTERNAL: MonitorRect = (1512, -200, 2560, 1440);

    fn geometry(x: i32, y: i32) -> WindowGeometry {
        WindowGeometry {
            x,
            y,
            width: 1100,
            height: 720,
            maximized: false,
        }
    }

    #[test]
    fn geometry_on_a_monitor_is_kept() {
        let saved = geometry(100, 100);
        assert_eq!(clamp_to_monitors(saved, &[LAPTOP, EXTERNAL]), Some(saved));
    }

    #[test]
    fn geometry_on_a_detached_monitor_is_rejected() {
        // Saved while on the external display, restored after unplugging it.
        let saved = geometry(2000, 300);
        assert_eq!(clamp_to_monitors(saved, &[EXTERNAL]), Some(saved));
        assert_eq!(clamp_to_monitors(saved, &[LAPTOP]), None);
    }

    #[test]
    fn barely_offscreen_geometry_is_rejected() {
        // Only a sliver overlaps: too little to grab the titlebar.
        let saved = geometry(-1100 + MIN_VISIBLE_PX - 1, 100);
        assert_eq!(clamp_to_monitors(saved, &[LAPTOP]), None);
        let reachable = geometry(-1100 + MIN_VISIBLE_PX, 100);
        assert_eq!(clamp_to_monitors(reachable, &[LAPTOP]), Some(reachable));
    }

    #[test]
    fn geometry_round_trips_through_the_state_dir() {
        let state = tempfile::tempdir().expect("temp state dir");
        let saved = WindowGeometry {
            x: 40,
            y: 60,
            width: 900,
            height: 700,
            maximized: true,
        };
        save_geometry(state.path(), "/vaults/notes", saved).expect("save");
        assert_eq!(load_geometry(state.path(), "/vaults/notes"), Some(saved));
        // The file lives under the state dir, keyed by hash, not by vault path.
        let file = geometry_file(state.path(), "/vaults/notes");
        assert!(file.starts_with(state.path()));
        assert!(!file.to_string_lossy().contains("notes"));
    }

    #[test]
    fn vault_keys_fold_case_on_case_insensitive_platforms() {
        let a = vault_key(Path::new("/Vaults/Notes"));
        let b = vault_key(Path::new("/vaults/notes"));
        if cfg!(any(target_os = "macos", target_os = "windows")) {
            assert_eq!(a, b);
        } else {
            assert_ne!(a, b);
        }
        assert_eq!(vault_id(&a).len(), 16);
    }
}
