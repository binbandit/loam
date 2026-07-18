# Contributing to Loam

Thanks for helping build an open, local-first knowledge base. This guide applies to humans and AI agents alike; where SPEC.md decides something, that decision is final for v1.

## Setup

Deterministic setup is a project requirement:

```sh
pnpm install
pnpm dev
```

Toolchain versions are pinned in `.node-version`, `package.json` (`packageManager`), and `rust-toolchain.toml`. `pnpm toolchain:check` verifies your environment matches.

## Quality gates

Run these before pushing; CI enforces the same commands:

```sh
pnpm lint          # workspace check, Biome, TypeScript strict typecheck, Clippy (-D warnings)
pnpm format:check  # Biome + rustfmt in check mode
pnpm test          # Turborepo test tasks + cargo-nextest
pnpm gates:check   # proves the gates reject known-bad fixtures
pnpm governance:check  # license fields, DCO self-test, affiliation scan
```

Do not add lint suppressions (`biome-ignore`, `#[allow(...)]`, `@ts-expect-error`) without a written justification in the code and the pull request.

## Developer Certificate of Origin (DCO)

Every commit must be signed off:

```sh
git commit -s
```

This adds a `Signed-off-by: Your Name <you@example.com>` trailer certifying you wrote the change or otherwise have the right to submit it under the project's licenses, per the [Developer Certificate of Origin 1.1](https://developercertificate.org/). There is no CLA. CI rejects commits without a valid sign-off (`node scripts/check-dco.mjs`).

## Clean-room rules (binding)

Loam is compatible with existing tools' *file formats*, never with their code or assets:

- Never copy, decompile, or transcribe code, CSS, icons, artwork, documentation, or marketing copy from Obsidian or any other proprietary product.
- Compatibility is implemented from observation of files on disk and public format documentation (CommonMark, YAML frontmatter, JSON Canvas at jsoncanvas.org).
- "Obsidian" and "Linear" may appear only as nominative references (for example, "works with your existing Obsidian vault"). Loam is not affiliated with, endorsed by, or sponsored by Obsidian or Linear, and project copy must never imply otherwise.

## Licensing

- The app and core (`apps/`, `crates/`, most `packages/`) are **AGPL-3.0-only** (see `LICENSE`).
- `packages/plugin-sdk` and `fixtures/` are **MIT** (see the `LICENSE` file in each); plugin authors may use any license for their own plugins.
- By signing off, you agree your contribution is licensed under the license of the files you touch.

### Dependency-license policy

All **runtime** dependencies must be compatible with AGPL-3.0 distribution. Acceptable: MIT, ISC, BSD-2/3-Clause, Apache-2.0, Zlib, MPL-2.0, Unicode, CC0, and the (L)GPL family. Not acceptable in the app: source-available or non-OSS licenses (for example Business Source License, Elastic License, or watermark-style licenses). Dev-only tooling has more latitude but must still be redistributable.

If a dependency's license is unknown or unusual, do not merge it: open an issue labeled `decision-needed` describing the dependency, its license text, and why it is needed, and wait for maintainer review. Automated auditing runs in CI after tests and fails on incompatible or unknown licenses: `pnpm licenses:audit` covers JS (pnpm's license checker against per-scope allow lists in `scripts/check-js-licenses.mjs`) and Rust (`cargo deny check licenses bans sources` against `deny.toml`). Approved exceptions are recorded in `deny.toml`/the script's allow lists with a linked issue.

## Commit and PR conventions

- Conventional Commits, release-please compatible: `feat(scope): ...`, `fix(scope): ...`, `chore: ...`, etc.
- One Linear issue per PR; every acceptance criterion needs at least one test.
- UI changes include screenshots or recordings for both themes.
- Coverage gates (once active): `loam-core` ≥ 85 % line, `packages/ui` ≥ 80 %.
