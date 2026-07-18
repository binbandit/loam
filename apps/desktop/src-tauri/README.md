# Tauri shell

Thin Tauri 2 shell (`loam-desktop`): window bootstrap, config, capabilities, and icons. All engine logic lives in `crates/loam-core`, which exposes no Tauri types; the webview reaches native functionality only through typed E06 IPC commands.

- `pnpm dev:native` — run the desktop app against the Vite dev server
- `pnpm build:native` — unsigned production bundles (also driven by `scripts/build-artifacts.mjs` in CI)
- `capabilities/` — least-privilege grants (hardened in LOA-36)
- `gen/schemas/` is build output and stays untracked
