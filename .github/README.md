# Repository automation

## CI (`workflows/ci.yml`)

The §5.13 gate order, wired per LOA-9: **lint/format → tests (ubuntu/macos/windows) + coverage → license audit → bundle budget → perf → build artifacts**. The license audit (LOA-10) runs `pnpm licenses:audit` offline; bundle budget, perf, and artifact builds are placeholders until LOA-11/E29 land.

- The lint job gates everything: Biome, strict typecheck, Clippy `-D warnings`, rustfmt, negative-fixture gates, governance checks, and DCO sign-off on PRs.
- Caching (cost control): the pnpm store is keyed by `pnpm-lock.yaml` (actions/setup-node); the Rust dependency cache by `Cargo.lock` + the pinned toolchain (actions-rust-lang/setup-rust-toolchain, active in every Rust job); Turborepo's content-hashed local cache is persisted per-OS (safe to restore stale); Playwright browsers are cached per-OS keyed by the lockfile; and `tauri-driver` is a cached prebuilt binary (taiki-e/cache-cargo-install-action) instead of a ~15-minute source compile per run.
- `concurrency` cancels superseded in-progress runs per ref, including `main` — only the newest push's verdict matters, and cancelling stops billing immediately.
- On failure, Playwright reports and the nextest `ci`-profile JUnit file are uploaded as artifacts (7-day retention); GitHub's default secret redaction applies and artifact paths are scoped to test output only.
- `.github/actions/setup-workspace` is the shared Node/pnpm/dependency setup used by every job; `.github/actions/setup-native` adds the pinned Rust toolchain and Linux WebKit build dependencies.
- **Native smoke** (`native-smoke` job): **Linux** runs the full tauri-driver WebDriver smoke (boot, page-ready assert, title, close). **macOS and Windows run boot-level smokes** (process alive + real titled window + screenshot artifact): macOS because WKWebView has no WebDriver at all, Windows because the msedgedriver↔WebView2 attach hangs inside the tauri-driver chain despite matched drivers and correct capabilities (upstream: tauri-apps/tauri#9653; re-attempt with `LOAM_SMOKE_WEBDRIVER=1`). Page-level verification for both stays on the weekly manual checklist in `docs/native-smoke-checklist.md`, whose completeness is linted in CI (`pnpm checklist:check`). Native failures upload screenshots, page source, and the tauri-driver log.

Issue templates, dependency automation (Renovate), and release workflows (release-please, signing) arrive with later E00/E26 stories.
