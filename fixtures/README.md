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
- Tests must never write into this directory at runtime — use `helpers/vault.ts` to create temp vaults in the OS temp directory and dispose of them. The one sanctioned exception is the explicit fixture-authoring mode below; it never runs in CI.

## `markdown/` conventions (§3.3)

Each fixture is a pair inside a syntax-family directory (`core/`, `gfm/`, `links/`, `frontmatter/`, `malformed/`, …):

- `<name>.md` — the source, and the only copy of it. Line endings are normalized to `\n` by every consumer, so extraction ranges are identical across OS checkouts.
- `<name>.expected.json` — `{ meta, extraction, lezer, rendering }`:
  - `meta.provenance` must be `"original"` and `meta.license` must be `"MIT"` (enforced by the runner; D12).
  - `extraction` is the serialized `loam_core::parse::ExtractedDoc`, including expected `diagnostics` — malformed and escaped inputs are first-class fixtures.
  - `lezer` and `rendering` are reserved (`null` for now) for the Live Preview and Reading expectations, so frontend consumers attach to the same fixture without duplicating the source.

Run the corpus with `cargo test -p loam-core --test markdown_fixtures`. Mismatches report the fixture path, a JSON pointer, and the source byte range. To author or refresh expectations, run `LOAM_UPDATE_FIXTURES=1 cargo test -p loam-core --test markdown_fixtures`, then review the resulting diff before committing.

Loam-dialect rules the corpus gates (`extensions/`, `tags/`, `blocks/` families):

- `==highlight==` closes within one paragraph; a blank line voids the opener and both delimiters stay literal. Soft line breaks are fine.
- `%%comment%%` may span lines and paragraphs; an unclosed `%%` comments out the rest of the note (with an `unclosed-comment` diagnostic). Comments are hidden at render time only — never removed from source — and links/tags/block IDs inside them are not indexed.
- `> [!type] Title` callouts: types are lowercased and §3.3 aliases resolve to canonical types (`summary`→`abstract`, `error`→`danger`, …); unknown types are kept and flagged `custom`. Fold markers `[!type]-` / `[!type]+` and nesting depth are retained.
- Tags require a whitespace (or start-of-line) boundary, allow Unicode letters plus `-`/`_`/`/`, and cannot be all-numeric. Block IDs are ` ^id` line suffixes (ASCII alphanumeric + `-`) outside code, math, and frontmatter.
- Escaped delimiters (`\==`, `\%%`, `\#tag`) always stay literal.
