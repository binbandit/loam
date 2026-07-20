# @loam-app/ui

Loam's design system (E07): the §4.2 token/typography sheet and the §4.3
React primitives, built on Base UI + Floating UI and styled exclusively with
tokens (`scripts/check-hardcoded-colors.mjs` enforces this).

## Structure

- `src/tokens/tokens.css` — the §4.2 custom properties. The dark block
  byte-matches SPEC.md and is snapshot-locked; edit SPEC first.
- `src/tokens/fonts.css` + `fonts/` — bundled Inter, JetBrains Mono, and
  Source Serif 4 (all SIL OFL, notices alongside).
- `src/theme.tsx` — `ThemeProvider`/`useTheme` (`dark | light | system`);
  the applied theme lands as `data-theme` on `<html>`.
- `src/components/` — primitives, colocated with their styles, tests, and
  stories.

## Stories (LOA-53)

Every exported primitive must ship stories for its supported states —
`stories.test.tsx` fails the suite when an exported component appears in no
`*.stories.tsx`. Run the explorer with:

```sh
pnpm stories        # Ladle dev server
```

The host loads the token sheet, follows Ladle's dark/light switch, and adds
a toolbar (bottom-left) that toggles the reduced-motion and
reduced-transparency collapses via the token sheet's attribute overrides
(`data-motion` / `data-transparency` on `<html>`).

### Story requirements for new primitives

1. Colocate `<component>.stories.tsx` with the component; use the
   `Primitives / <Area>` title convention.
2. Cover every visual state the component supports (variants, disabled,
   invalid, loading, selected, drop/rename, …) — the visual matrix
   snapshots whatever the stories show.
3. Never hardcode colors in story styles; use tokens.
4. Interactive-only states (hover, drag) get a story that renders the state
   via props where possible (e.g. `data-` attributes), so snapshots see them.

## Visual regression

`scripts/visual-regression.mjs` builds the Ladle host and snapshots every
story in dark **and** light with Playwright Chromium (fixed 720×480
viewport, `deviceScaleFactor: 1`, reduced motion emulated, bundled fonts
awaited — captures hash identically across runs).

```sh
pnpm visual:check         # compare against committed baselines (+ diff self-test)
pnpm visual:update        # rewrite baselines (or LOAM_UPDATE_FIXTURES=1)
pnpm visual:determinism   # capture everything twice and compare hashes
```

Baselines live in `visual-baselines/` (committed, macOS-rendered — the CI
job runs on macOS for matching antialiasing). Failures write
`<story>--<theme>.actual.png` and `.diff.png` to `visual-artifacts/`, which
the CI job uploads as the `visual-diffs` artifact.
