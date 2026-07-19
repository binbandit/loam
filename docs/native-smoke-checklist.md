# macOS native smoke checklist (weekly)

macOS has **no WKWebView WebDriver support**, and on Windows the msedgedriver↔WebView2 attach currently hangs inside the tauri-driver chain (upstream: tauri-apps/tauri#9653 — matched driver versions and correct `webviewOptions` capabilities verified; re-attempt via `LOAM_SMOKE_WEBDRIVER=1`). CI therefore runs automated **boot smokes** on macOS and Windows (process alive + titled window on screen + screenshot artifact), and the **full WebDriver smoke on Linux**. Everything below the boot level in this scripted/manual checklist is the accepted §5.12 substitute for macOS and Windows, run weekly on real hardware and before every release. `pnpm checklist:check` lints this file for completeness.

> The weekly run covers **both macOS and Windows** until the Windows WebDriver leg is restored.

> Always test a build that embeds the frontend: the **bundled `Loam.app`** (`target/release/bundle/macos/Loam.app`) or a binary built with `--features custom-protocol`. A bare `cargo build` binary points its webview at the Vite dev URL and renders a blank window — this masqueraded as a "bundle-only" limitation until the native smoke harness isolated it (LOA-49).

## Checklist

- [ ] **Boot**: `Loam.app` opens one window titled "Loam"; content renders (dark background, titlebar, "Loam" heading) in under ~1 s.
- [ ] **Focus**: clicking another app and re-clicking the Loam dock icon refocuses the window; with all windows closed, clicking the dock icon reopens the first-run window.
- [ ] **Close**: ⌘W / red traffic light closes the window; the app exits with its last window; reopening restores the window on the same display within visible bounds.
- [ ] **Folder picker**: File ▸ "Open vault…" (and the in-app "Open folder" button) opens the native folder picker; choosing a folder opens a vault window titled with the folder name; cancelling does nothing.
- [ ] **Duplicate open**: opening the same folder again focuses the existing vault window instead of creating a second one.
- [ ] **Titlebar overlay**: traffic lights sit over the slim titlebar without overlapping the vault name; no control shifts on hover.
- [ ] **Menus**: File/Edit/View/Window/Help present; shortcut glyphs visible on rows that declare them (⌘N, ⇧⌘N, ⌘F, ⌘E, ⌘., ⇧⌘., ⌘,).
- [ ] **CLI open**: `open -n Loam.app --args "<folder with spaces/unicode>"` opens that vault window.
- [ ] **Drag-drop**: dragging a folder onto the first-run window opens it as a vault.
- [ ] **Deep link**: `open "loam://open?path=<url-encoded folder>"` opens the vault; a malformed URI does nothing (error logged, no window).

## Recording results

Note the date, macOS version, hardware, and any failure (with screenshot) in the release notes or the tracking issue for that week.
