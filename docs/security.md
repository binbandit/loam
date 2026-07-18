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
- Any non-`core:*` permission or new plugin crate fails `security:check` and requires a security review to land.

## CSP (default-deny)

Production (`app.security.csp`): `default-src 'self'`; scripts/styles/fonts self-only; images self + `data:`; `connect-src` limited to the Tauri IPC bridge (`ipc:`, `http://ipc.localhost`); objects and frames `'none'`. No remote origin appears anywhere, so any network fetch from the webview is blocked — plugin `net.fetch` (E20) will proxy through the Rust core with per-plugin permission, not through CSP holes.

Dev (`devCsp`): same policy plus the Vite dev server (`http://localhost:5173`, `ws://localhost:5173` for HMR) and `'unsafe-inline'` (React fast-refresh preamble). Dev-only; never shipped.

## Runtime verification status

Structural guarantees are enforced by `pnpm security:check` in CI. Runtime negative tests — attempting an out-of-scope file read and an external fetch from inside the real webview — land with the tauri-driver harness (LOA-49) since they need a native window to drive.
