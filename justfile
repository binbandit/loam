# Loam task runner. `just` with no arguments lists everything.
#
# The gates below mirror the CI job order in .github/workflows/ci.yml
# (§5.13): lint/format → tests → license audit → bundle budget → perf.

set shell := ["bash", "-uc"]

_default:
    @just --list

# Run the desktop app (Tauri shell + Vite dev server, hot reload).
run:
    pnpm --filter @loam-app/desktop dev:native

# The web build in a browser, against the mock transport — no Rust needed.
run-web:
    pnpm --filter @loam-app/desktop dev

# Unsigned native bundle for this platform.
build:
    pnpm --filter @loam-app/desktop build:native

# ── Gates ───────────────────────────────────────────────────────────────────

# Biome, typecheck, Clippy, and the hardcoded-colour scan.
lint:
    pnpm lint

# Every unit suite: TypeScript workspaces + the Rust workspace.
test:
    pnpm test

# Playwright browser smoke against the built web app.
e2e:
    pnpm test:e2e

# Ladle story snapshots in both themes, plus the perturbation self-test.
visual:
    pnpm visual:check

# Coverage gates (loam-core ≥ 85 %, @loam-app/ui ≥ 80 %).
coverage:
    pnpm coverage

# Editor keystroke p95 against the 16 ms budget and the committed baseline.
bench:
    pnpm editor:bench:check

# Cold-path bundle budget: no KaTeX/Mermaid/Shiki/graph/canvas modules.
bundle:
    pnpm bundle:check

# Everything CI runs, in CI's order. Slow; this is the pre-push check.
check: lint test e2e bundle bench visual coverage
    @echo "All gates passed."

# ── Housekeeping ────────────────────────────────────────────────────────────

# Biome + rustfmt, writing fixes.
fmt:
    pnpm format

# Regenerate IPC bindings and fixtures after a contract change (§5.4).
fixtures:
    LOAM_UPDATE_FIXTURES=1 cargo test -p loam-desktop

# Re-record visual baselines. Review the diff before committing.
visual-update:
    pnpm visual:update

# Refresh the editor performance baseline and docs/editor-perf.md.
bench-update:
    node scripts/editor-bench.mjs --write-baseline --write-doc
