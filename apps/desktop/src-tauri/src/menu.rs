//! Native application menus (LOA-44, §3.5). Every row is backed by an E12
//! command ID and emits a `menu://command` event to the frontend; command
//! *execution* arrives with E12. Text-editing rows use native predefined items
//! so platform behavior (and IME correctness) stays native.

use tauri::menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Event carrying the activated command ID to the focused webview.
pub const COMMAND_EVENT: &str = "menu://command";

/// One command-backed menu row. Accelerators use Tauri's cross-platform
/// syntax; native menus render the platform shortcut glyphs from them, which
/// is how every row with a shortcut displays it (AC3).
pub struct CommandRow {
    pub menu: &'static str,
    pub id: &'static str,
    pub label: &'static str,
    pub accelerator: Option<&'static str>,
}

/// §3.12 default keymap subset that exists at M0. E12 owns the full surface.
pub const COMMAND_ROWS: &[CommandRow] = &[
    CommandRow {
        menu: "app",
        id: "app.settings",
        label: "Settings…",
        accelerator: Some("CmdOrCtrl+,"),
    },
    CommandRow {
        menu: "file",
        id: "file.open-vault",
        label: "Open vault…",
        accelerator: None,
    },
    CommandRow {
        menu: "file",
        id: "file.new-note",
        label: "New note",
        accelerator: Some("CmdOrCtrl+N"),
    },
    CommandRow {
        menu: "file",
        id: "file.new-window",
        label: "New window",
        accelerator: Some("CmdOrCtrl+Shift+N"),
    },
    CommandRow {
        menu: "edit",
        id: "editor.find",
        label: "Find in note",
        accelerator: Some("CmdOrCtrl+F"),
    },
    CommandRow {
        menu: "view",
        id: "view.toggle-reading",
        label: "Toggle reading view",
        accelerator: Some("CmdOrCtrl+E"),
    },
    CommandRow {
        menu: "view",
        id: "view.toggle-left-sidebar",
        label: "Toggle sidebar",
        accelerator: Some("CmdOrCtrl+Shift+."),
    },
    CommandRow {
        menu: "view",
        id: "view.toggle-right-panel",
        label: "Toggle right panel",
        accelerator: Some("CmdOrCtrl+."),
    },
    CommandRow {
        menu: "help",
        id: "help.open",
        label: "Loam help",
        accelerator: None,
    },
];

fn command_item<R: Runtime>(app: &AppHandle<R>, row: &CommandRow) -> tauri::Result<MenuItem<R>> {
    let mut builder = MenuItemBuilder::with_id(row.id, row.label);
    if let Some(accelerator) = row.accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder.build(app)
}

fn rows(menu: &'static str) -> impl Iterator<Item = &'static CommandRow> {
    COMMAND_ROWS.iter().filter(move |row| row.menu == menu)
}

/// Build the full application menu: File, Edit, View, Window, Help (plus the
/// macOS app menu). Called from `run()` only — native menu construction must
/// happen on the main thread.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let mut menu = MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    {
        let mut app_menu = SubmenuBuilder::new(app, "Loam").about(None).separator();
        for row in rows("app") {
            app_menu = app_menu.item(&command_item(app, row)?);
        }
        let app_menu = app_menu
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }

    let mut file = SubmenuBuilder::new(app, "File");
    for row in rows("file") {
        file = file.item(&command_item(app, row)?);
    }
    #[cfg(not(target_os = "macos"))]
    {
        for row in rows("app") {
            file = file.item(&command_item(app, row)?);
        }
        file = file.separator().quit();
    }
    let file = file.build()?;

    let mut edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator();
    for row in rows("edit") {
        edit = edit.item(&command_item(app, row)?);
    }
    let edit = edit.build()?;

    let mut view = SubmenuBuilder::new(app, "View");
    for row in rows("view") {
        view = view.item(&command_item(app, row)?);
    }
    let view = view.build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .separator()
        .close_window()
        .build()?;

    let mut help = SubmenuBuilder::new(app, "Help");
    for row in rows("help") {
        help = help.item(&command_item(app, row)?);
    }
    let help = help.build()?;

    menu.item(&file)
        .item(&edit)
        .item(&view)
        .item(&window)
        .item(&help)
        .build()
}

/// Forward an activated menu row to the frontend as a command event.
pub fn forward_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    app.emit(COMMAND_EVENT, id).ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AC3 at the data level: the declarative table is the single source the
    /// native menus render from, so every shortcut-bearing row declares a
    /// well-formed accelerator and every ID uses the E12 namespace format.
    #[test]
    fn command_rows_are_well_formed() {
        assert!(!COMMAND_ROWS.is_empty());
        for row in COMMAND_ROWS {
            assert!(
                row.id.split('.').count() >= 2
                    && row
                        .id
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c == '.' || c == '-'),
                "command id must be namespaced kebab-case: {}",
                row.id
            );
            assert!(!row.label.is_empty());
            if let Some(accelerator) = row.accelerator {
                assert!(
                    !accelerator.is_empty() && accelerator.contains("CmdOrCtrl"),
                    "accelerators use cross-platform modifiers: {accelerator}"
                );
            }
        }
    }

    /// §3.12 keymap: shortcuts in the table must match the spec's defaults.
    #[test]
    fn accelerators_match_the_spec_keymap() {
        let expect = [
            ("app.settings", "CmdOrCtrl+,"),
            ("file.new-note", "CmdOrCtrl+N"),
            ("file.new-window", "CmdOrCtrl+Shift+N"),
            ("editor.find", "CmdOrCtrl+F"),
            ("view.toggle-reading", "CmdOrCtrl+E"),
            ("view.toggle-right-panel", "CmdOrCtrl+."),
            ("view.toggle-left-sidebar", "CmdOrCtrl+Shift+."),
        ];
        for (id, accelerator) in expect {
            let row = COMMAND_ROWS
                .iter()
                .find(|row| row.id == id)
                .unwrap_or_else(|| panic!("missing row {id}"));
            assert_eq!(row.accelerator, Some(accelerator), "shortcut for {id}");
        }
    }
}
