# Fixtures

MIT-licensed synthetic Markdown, JSON Canvas, path, and performance fixtures live here. Proprietary product content is never copied into this corpus.

## Layout conventions

| Directory | Contents |
| --- | --- |
| `markdown/` | Markdown conformance corpus (§3.3) — the contract between comrak and Lezer |
| `canvas/` | JSON Canvas round-trip corpus (§3.10) |
| `vaults/` | Deterministic generators for `bench-1k` / `bench-10k` / `bench-100k` reference vaults (§5.9) |
| `typescript/`, `rust/`, `coverage/` | Negative fixtures for the quality gates (`pnpm gates:check`, `pnpm coverage:check`) |
| `helpers/` | Test helper code (for example `vault.ts`, which creates disposable temp vaults outside the repository) |

## Rules

- Corpus directories are **byte-exact**: editors and formatters must never touch them. They are excluded in `biome.json` and `.editorconfig`; add any new corpus directory to both lists.
- Helper and generator code under `helpers/` (and future `vaults/` generators) is regular linted, strict-typed source.
- Tests must never write into this directory at runtime — use `helpers/vault.ts` to create temp vaults in the OS temp directory and dispose of them.
