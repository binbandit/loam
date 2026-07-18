# Native trust boundary

This documents the §5.10 security posture as implemented in LOA-36. `pnpm security:check` (`scripts/check-security-config.mjs`) enforces every claim below against the actual manifests; if you change one, change the other in the same PR.

## The boundary

```
┌───────────────── webview (untrusted-ish: runs app + future community plugins) ─────────────────┐
│  React app · plugin runtime (E20)                                                              │
│  May only: render, and call typed E06 IPC commands                                             │
└──────────────────────────────── typed IPC (tauri-specta) ──────────────────────────────────────┘
┌───────────────── Rust shell + core (trusted: all fs/network/process decisions) ────────────────┐
│  loam-desktop (thin shell) → loam-core (vault fs, index, search)                               │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

All filesystem, network, and process trust decisions live on the Rust side. The webview cannot reach the OS except through commands we define.

## What the webview is granted (capabilities)

`apps/desktop/src-tauri/capabilities/default.json`, identical on macOS/Windows/Linux (`platforms` is explicit):

- `core:app:default`, `core:event:default`, `core:window:default` — window/event plumbing only.

What is deliberately absent:

- **No filesystem permissions.** `tauri-plugin-fs` is not shipped. Vault file access will arrive only through typed E06 commands (`note_read`, `note_write`, …) whose implementations in `loam-core` enforce vault-root scoping — that is the §5.10 "fs scoped to opened vault roots + app-data" guarantee: the scope check lives in Rust, not in a grant to the webview.
- **No shell/process execution.** `tauri-plugin-shell`/`tauri-plugin-process` are not shipped and no generic "run command" bridge exists.
- **No asset protocol.** `assetProtocol.enable: false` with an empty scope.
- **Rust-side-only plugins (LOA-48).** `tauri-plugin-dialog` (folder picker) and `tauri-plugin-deep-link` (`loam://` scheme) are registered, but **no capability grants the webview any of their permissions** — the webview can only call the typed `vault_pick_and_open` / `vault_open` commands, and IPC tests assert `plugin:dialog|*` / `plugin:deep-link|*` invokes are ACL-denied. Deep-link URIs are parsed as untrusted input with stable error codes.
- Any non-`core:*` permission or fs/shell/process plugin crate fails `security:check` and requires a security review to land.

## CSP (default-deny)

Production (`app.security.csp`): `default-src 'self'`; scripts/styles/fonts self-only; images self + `data:`; `connect-src` limited to the Tauri IPC bridge (`ipc:`, `http://ipc.localhost`); objects and frames `'none'`. No remote origin appears anywhere, so any network fetch from the webview is blocked — plugin `net.fetch` (E20) will proxy through the Rust core with per-plugin permission, not through CSP holes.

Dev (`devCsp`): same policy plus the Vite dev server (`http://localhost:5173`, `ws://localhost:5173` for HMR) and `'unsafe-inline'` (React fast-refresh preamble). Dev-only; never shipped.

## Runtime verification status

Three layers enforce this boundary today, all in CI:

1. **Structural** — `pnpm security:check` validates the capability manifests, plugin crate list, CSP source allow-lists, platform exactness, and asset-protocol state against this document's claims.
2. **IPC bridge (AC1/AC2)** — Rust tests in `apps/desktop/src-tauri/src/lib.rs` drive the real invoke pipeline (Tauri mock runtime with the **real generated context**, so the shipped ACL is enforced) on a webview labeled `main`: `plugin:fs|read_text_file` of an outside path, `plugin:shell|execute`/`open`, and `plugin:process|exit` are all rejected; an ungranted core plugin (`plugin:image|new`) is denied by the ACL; and a granted command (`plugin:app|version`) succeeds as the positive control proving the denials are real.
3. **CSP (AC3)** — a Playwright test (`apps/desktop/e2e/csp.spec.ts`) serializes the production `csp` from `tauri.conf.json`, applies it to the built app in a real browser engine, and proves the app boots while an external `fetch` is blocked by CSP (with an instrumented route making any leak loud).

Remaining gap, deliberately deferred to LOA-49: the same probes executed inside the *platform* webviews (WKWebView/WebView2/WebKitGTK) via tauri-driver, which needs a driven native window and Windows/Linux runners.
