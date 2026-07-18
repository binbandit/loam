# Repository automation

## CI (`workflows/ci.yml`)

The §5.13 gate order, wired per LOA-9: **lint/format → tests (ubuntu/macos/windows) + coverage → license audit → bundle budget → perf → build artifacts**. The license audit (LOA-10) runs `pnpm licenses:audit` offline; bundle budget, perf, and artifact builds are placeholders until LOA-11/E29 land.

- The lint job gates everything: Biome, strict typecheck, Clippy `-D warnings`, rustfmt, negative-fixture gates, governance checks, and DCO sign-off on PRs.
- Caching: the pnpm store is keyed by `pnpm-lock.yaml` (actions/setup-node) and the Rust cache by `Cargo.lock` + the pinned toolchain (actions-rust-lang/setup-rust-toolchain), so lockfile or toolchain changes always miss.
- `concurrency` cancels superseded runs per ref; `main` runs are never cancelled.
- On failure, Playwright reports and the nextest `ci`-profile JUnit file are uploaded as artifacts (7-day retention); GitHub's default secret redaction applies and artifact paths are scoped to test output only.
- `.github/actions/setup-workspace` is the shared Node/pnpm/dependency setup used by every job.

Issue templates, dependency automation (Renovate), and release workflows (release-please, signing) arrive with later E00/E26 stories.
