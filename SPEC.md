# Loam — Product & Engineering Specification

**Version:** 1.0 · **Status:** Ready for ticket generation · **Working name:** Loam (see §9 — treat as a global find-and-replace variable until trademark clearance)

Loam is an open-source, local-first knowledge base: Obsidian-class capability with Linear-class craft. Plain Markdown files on disk, a fast Rust core, a keyboard-first interface, and an extensible plugin system — free forever, AGPL-licensed, community-owned.

This document is the single source of truth for scope, architecture, design, and delivery. It is written to be consumed by an AI that will generate Linear tickets, and by the AI agents that will implement them.

---

## 0. How to use this document (instructions to the ticket-generating AI)

1. **Authority.** This spec outranks your own preferences. Where the spec decides something (a library, a token value, an interaction), that decision is final for v1. Do not re-architect, substitute libraries, or invent features not present here.
2. **Gaps.** If you find genuine ambiguity, do not improvise. Create a ticket labeled `decision-needed` describing the ambiguity, the options, and a recommendation. Section §5.14 lists the known deferred decisions; those already have spike tickets defined.
3. **Structure mapping.** One Linear *project* per epic (§6.2). One Linear *issue* per story. Milestones M0–M6 (§6.1) map to Linear milestones/cycles. Use the ticket schema in §6.3 verbatim and match the worked examples in §6.4.
4. **Sizing.** Every issue must be completable by one competent agent in ≤ 1 working day. If a story is larger, split it. Interfaces and acceptance criteria defined in this doc must be copied into tickets verbatim, not paraphrased.
5. **Ordering.** Respect epic dependencies (§6.2). Generate full detail only for the current milestone plus the next one; later milestones get placeholder epics only (rolling-wave planning).
6. **Naming.** The product name "Loam" is a variable. If the maintainer renames the project after trademark checks (§9), rename is a single global substitution — `loam-*` identifiers are fine to use freely because §9.4 defines a scripted, CI-verified rename path.

---

## 1. Product definition

### 1.1 One-liner

**Loam is the open-source home for your second brain: plain Markdown files, linked thought, and a tool fast enough to disappear.**

### 1.2 Positioning — the honest wedge

Be precise about what we are fixing, because the pitch "Obsidian but free" is not quite right and the community will call it out. As of 2026 the Obsidian app itself is free, including for commercial use; they charge for Sync (~$4–8/user/mo) and Publish (~$8–10/site/mo). The real wedge is:

- **Trust.** Obsidian is closed source. You cannot audit the binary that reads your entire life's notes, and the community re-litigates this constantly. Loam is AGPL, fully auditable, and can never be acquired-and-enshittified in a way the community can't fork.
- **Longevity.** Closed products die with their company. An open codebase plus plain files is the only durable answer for a tool people intend to use for decades.
- **Sync cost & control.** Loam is sync-agnostic by design (works cleanly with Syncthing, iCloud, Dropbox, Git) and will ship an optional self-hostable, end-to-end-encrypted sync server — the thing Obsidian charges for.
- **Speed.** Obsidian is an Electron app with a JavaScript indexer. Loam's Rust core (indexing, search, link graph) plus a native-webview shell targets cold starts under a second and instant search at 100k notes. Speed is a feature, in the Linear sense: it is the product's personality.
- **Contribution.** 4,000+ Obsidian community plugins exist despite the core being closed. An open core turns that energy loose on the whole product.

What we deliberately keep from Obsidian: files-over-app philosophy, vault model, wikilinks, the plugin ecosystem shape, and compatibility with existing vaults (§3.11) so switching is a five-minute decision, not a migration project.

### 1.3 Target users

1. **The Obsidian power user** with a 5k–100k note vault, 30 plugins, and unease about closed source. Needs: vault opens unmodified, muscle memory survives (keymap preset), plugin equivalents exist or are buildable.
2. **The developer/PKM enthusiast** choosing a first serious tool. Needs: credible longevity, beautiful defaults, no setup ceremony.
3. **The privacy-conscious professional** (lawyer, researcher, journalist). Needs: local-only guarantee, no telemetry by default, auditable code, E2E sync story.

### 1.4 Non-goals for 1.0

Real-time multiplayer editing; hosted cloud service; a block-based database à la Notion (an Obsidian-Bases-style table view is post-1.0, §3.15); WYSIWYG-only editing that hides Markdown; AI features in core (plugin territory); Windows-on-ARM before parity elsewhere.

### 1.5 Legal & ethical guardrails (binding on all implementation agents)

- **Clean-room rule.** Never copy, decompile, or transcribe Obsidian's code, CSS, icons, artwork, documentation, or marketing copy. Compatibility is achieved by implementing *formats* from observation of files on disk and public format documentation (Markdown, YAML frontmatter, JSON Canvas — the latter an openly published spec at jsoncanvas.org, implement from the spec).
- **Trademark rule.** "Obsidian" appears only as nominative reference ("works with your existing Obsidian vault"), never in our product name, logo, or app identifiers. Same for "Linear": we adopt interaction *values* (speed, keyboard-first, restraint) and build our own token system (§4); we do not copy Linear's assets, exact palette, icons, or copy.
- **Dependency licensing.** All runtime dependencies must be compatible with AGPL-3.0 distribution; no source-available/non-OSS licenses in the app (this excludes, e.g., tldraw's watermark license — noted in §5.2/D9).
- CI includes a license-audit step (`cargo deny`, `license-checker`) that fails on incompatible licenses.

---

## 2. Product principles (the Linear DNA, translated)

1. **Speed is the product.** Every interaction has a millisecond budget (§5.9). A feature that violates its budget is not done. No spinners for local operations; skeletons and optimistic updates only where unavoidable.
2. **Keyboard-first, mouse-complete.** Everything reachable via ⌘K. Every menu item shows its shortcut. The mouse path always exists but is never the only path.
3. **Opinionated defaults, quiet depth.** Zero-config first run: open a folder, start typing. Power (properties, templates, plugins, vim mode) reveals itself progressively and never clutters the default surface.
4. **Restraint.** One accent color. Two type families. Density without crowding. If a UI element can be removed without losing capability, remove it.
5. **The file is the truth.** Plain Markdown on disk is the canonical state. Every index is disposable and rebuildable. Nothing Loam writes can lock a user in — deleting the app leaves a perfectly usable folder of text.
6. **Local-first, private by default.** No accounts, no network calls without explicit action, telemetry strictly opt-in (§5.10).
7. **Compatible on purpose.** Where an open or de-facto format exists (CommonMark, wikilinks, YAML frontmatter, JSON Canvas), we implement it rather than inventing our own.
8. **Craft over breadth.** Ship fewer features finished to a higher standard than the category norm. "Feels like Linear" is the review quote we are engineering for.

---

## 3. Feature specification

Priorities: **P0** = required for M1–M2 (daily-driver), **P1** = required for 1.0, **P2** = post-1.0 roadmap. Every feature listed with a priority is in scope for ticket generation; §3.15 lists explicit exclusions. Acceptance-criteria style throughout: observable behavior, testable without interpretation.

### 3.1 Vaults & files

| Capability | Priority | Specification |
|---|---|---|
| Open vault | P0 | A vault is any folder. Open via picker, drag-drop onto window, CLI arg, or `loam://` URI. Multiple vaults, one window each (plus multi-window per vault P1). Recent-vaults switcher in ⌘K. |
| File tree | P0 | Left sidebar: folders/files, drag-drop move, inline rename (F2 / double-click), create note/folder, context menu (reveal in OS, copy path, duplicate, delete to OS trash), sort (name/modified), collapse state persisted per device. |
| File ops safety | P0 | All writes atomic (§5.6). Deletes go to OS trash. External edits detected < 1 s and reflected; conflict banner if buffer dirty (§5.6). |
| Attachments | P0 | Paste/drag images and files into a note → copied to configurable attachment folder (default `attachments/`, per-vault setting incl. "same folder as note" and subfolder-per-note), link inserted. Filename pattern setting (`Pasted image YYYYMMDDHHmmss` default for Obsidian familiarity). |
| Ignore rules | P1 | `.loamignore` (gitignore syntax) + built-in ignores (`.git`, `node_modules`, `.obsidian`, `.loam/cache` never exists in vault — see §5.5). Ignored files excluded from index/search/switcher. |
| Non-Markdown files | P1 | Images, PDFs, audio, video open in viewer tabs; unknown types open in OS default. PDF viewer with page thumbnails (P1). |
| File recovery | P1 | Local history: automatic snapshots on save (debounced, deduped), browsable timeline per note, restore/diff. Stored per device outside the vault (§5.5). Retention setting (default 30 days). |
| Vault stats | P2 | Note/word counts, growth over time. |

### 3.2 Editor

The editor is CodeMirror 6 in three modes: **Live Preview** (default — syntax renders in place, revealing raw markup only around the cursor), **Source** (plain Markdown with syntax highlighting), **Reading** (fully rendered, non-editable). ⌘E toggles edit/reading; mode-per-tab remembered.

P0 editor behaviors:

- Live Preview hides/reveals formatting marks per-line based on cursor/selection; embeds, images, callouts, math, tables render as widgets in-place. This is the hardest epic in the project (E10) and is built syntax-family by syntax-family behind granular flags.
- Typing latency budget p95 ≤ 16 ms in a 10k-word document (§5.9); documents > 2 MB automatically degrade to Source mode with a notice.
- Standard editing: multi-cursor (⌘-click, ⌘D select-next), smart lists (Enter continues, Tab/Shift-Tab indent, auto-renumber), task toggle (⌘L and click), smart pairs for `**` `_` `==` `` ` `` `[[`, paste-URL-onto-selection creates a link, Markdown-aware ⌘B/⌘I/⌘⇧X, drag-drop text blocks (P1), fold headings & lists (gutter chevrons appear on hover only).
- Find/replace in note (⌘F / ⌘⌥F) with regex toggle; count + highlight all.
- Vim mode (P1) via `@replit/codemirror-vim`; off by default.
- Spellcheck (P1): native webview spellcheck where available, per-vault language setting, disable-in-code-blocks.
- Undo history per tab survives tab switches; persisted across restart (P2).

### 3.3 Markdown syntax support

Dialect: CommonMark + GFM + the extensions below. One grammar implementation shared by index and reading view (comrak, §5.2/D4); Live Preview decorations driven by Lezer's Markdown parser with matching extensions. A conformance fixture corpus (`/fixtures/markdown/`) is the contract between the two — every row below has fixtures, and CI diffs both parsers against expected structure.

| Syntax | Priority | Notes |
|---|---|---|
| Headings, bold, italic, strikethrough, inline code, code fences | P0 | Fence language label → syntax highlighting: CM6 highlighting in edit modes; Shiki (lazy-loaded worker, cached) in Reading. |
| `==highlight==` | P0 | Renders as `<mark>` with `--loam-highlight` token. |
| Lists: bullet, ordered, task `- [ ]` / `- [x]`, nesting | P0 | Custom task states (`- [/]`, `- [-]` etc.) P1, styleable by themes. |
| Blockquotes | P0 | |
| Callouts `> [!note] Title` | P0 | Types: note, abstract/summary, info, todo, tip, success, question, warning, failure, danger, bug, example, quote (Obsidian-compatible set + aliases). Foldable via `[!note]-` / `[!note]+`. Nesting supported. Custom types render with default icon + type-derived color. |
| Tables | P0 render / P1 editing UX | P1: tab between cells, row/column add-remove controls on hover, paste-from-spreadsheet → table. |
| Footnotes | P0 | Inline `^[..]` P1. |
| Math: `$inline$`, `$$block$$` | P0 | KaTeX, lazy-loaded. |
| Mermaid code blocks | P1 | Lazy-loaded, rendered as widget, themed to match app tokens. |
| Wikilinks `[[Note]]`, `[[Note\|alias]]`, `[[Note#Heading]]`, `[[Note#^block]]` | P0 (block refs P1) | Resolution rules §3.4. |
| Markdown links, autolinks | P0 | External links open in OS browser; ⌘-hover shows URL; internal `[text](note.md)` resolves like a wikilink. |
| Embeds `![[Note]]`, `![[Note#Heading]]`, `![[Note#^block]]`, `![[img.png\|300]]`, `![[doc.pdf#page=4]]`, audio, video | P0 note/heading/image; P1 block/pdf-page/av | Recursive embeds cycle-guarded (max depth 5, cycle renders an inline error chip). |
| Tags `#tag`, nested `#area/sub`, Unicode letters allowed | P0 | Clickable → search filter. |
| Comments `%%hidden%%` | P0 | Hidden in Reading; dimmed in edit modes. |
| YAML frontmatter | P0 | See §3.7. |
| Inline HTML (sanitized subset) | P1 | DOMPurify allowlist; script/style stripped; iframes off by default (per-vault opt-in P2). |
| Escapes `\*` etc. | P0 | |

### 3.4 Linking & knowledge features

- **Link resolution (P0):** wikilink targets resolve case-insensitively by (1) exact path, (2) unique filename anywhere in vault, (3) alias (frontmatter `aliases`). Ambiguous name → nearest-path heuristic + squiggle warning with quick-fix. New-link format setting: shortest-when-unique (default), relative path, or absolute-in-vault; option to prefer `[markdown](links)` over wikilinks (for compat with other tools).
- **Autocomplete (P0):** typing `[[` opens an inline suggest popup — fuzzy over titles + aliases + headings (after `#`) + blocks (after `^`, P1); creates-on-Enter for unresolved names ("Create 'X'" row). `![[` behaves identically for embeds.
- **Unresolved links (P0):** render distinctly (dashed underline, `--loam-text-tertiary`); clicking creates the note (location per new-note setting); they appear in graph as ghost nodes (P1) and in backlinks-of-target once created.
- **Rename = refactor (P0):** renaming/moving a note or heading rewrites every inbound link vault-wide. > 20 affected files → preview modal listing changes (Linear-style diff list) with confirm; operation is atomic-per-file, cancellable, and reported ("Updated 143 links in 87 notes"). Budget §5.9.
- **Backlinks panel (P0):** right panel section "Linked mentions" with per-note grouped, syntax-highlighted snippet context, click-to-jump; "Unlinked mentions" (P1) finds plain-text occurrences of title/aliases with one-click link-ification.
- **Outgoing links panel (P1).**
- **Page preview (P1):** ⌘-hover (configurable to plain hover) over any internal link → floating rendered preview popover, scrollable, ESC/mouse-out dismiss, nested-preview allowed depth 2.
- **Note composer (P1):** extract selection into new note (leaving a link), merge note into another (redirecting backlinks).
- **Block IDs (P1):** ` ^id` suffix on any block; auto-generated on block-embed/copy-block-link commands.

### 3.5 Navigation, panes & the command system

- **Omnibar ⌘K (P0):** one Linear-style menu for everything: fuzzy note switching (title + alias + heading + path), commands, and actions on the current note. Sections: *Recent* (frecency), *Notes*, *Commands*, *Create "query…"*. Right-aligned shortcut hints; `>` prefix filters to commands only; `#` to tags; `?` to search. ⌘O opens the same surface pre-filtered to notes and ⌘P pre-filtered to commands (muscle-memory aliases). Sub-menus supported (Linear's "…then choose" pattern) e.g. "Move to folder…". Opens < 50 ms; plugin-extensible providers (§5.7).
- **Tabs & splits (P0):** tabs per window; ⌘T/⌘W/⌘⇧T; drag to reorder, drag to edge → split (horizontal/vertical, nested); focus follows Linear-style subtle top-border accent on active pane; pinned tabs (P1); tab overflow menu. Layout persisted per device (§5.5).
- **History (P0):** per-pane back/forward (⌘[ / ⌘]) across note navigations.
- **Right panel (P0):** collapsible, tabbed: Backlinks, Outline, Tags (vault-wide with counts, P0), Local graph (P1), plugin views. Outline = clickable heading tree of active note, syncs highlight on scroll.
- **Status bar (P0):** minimal single line: sync/index status glyph, word+char count of active note, cursor position (source mode), plugin items right-aligned. Hidden in zen mode.
- **Zen / focus mode (P1):** ⌘⇧Enter hides all chrome; typewriter scrolling option.
- **Window (P0):** native traffic lights/controls, custom slim titlebar with vault name + note breadcrumb, overlay-style titlebar on macOS.
- **URI scheme (P1):** `loam://open?vault=<id>&file=<path>` plus `new`, `search`, `daily` actions (Obsidian-style automation compatibility).

### 3.6 Search

- **Global search ⌘⇧F (P0):** left-panel view. Full-text (tantivy) with < 150 ms p95 at 100k notes. Operators: `tag:#x`, `path:folder/`, `file:name`, `line:(a b)` (P1), `[property:value]` (P1), quoted phrases, `-` negation, `OR`, parentheses. Results grouped by note with highlighted snippet lines, keyboard navigable, Enter opens at match. "Search settings" popover: match case, whole word, regex (P1 — regex runs ripgrep-style scan in core, not tantivy).
- **Search & replace across vault (P2).**
- **Quick switcher ranking (P0):** nucleo fuzzy matcher over titles/aliases/paths with frecency boost (open-count decay). Never blocks: results stream.
- **Saved searches (P1):** pin a query to the left panel; embeddable query code block (` ```query `) in notes (P2).

### 3.7 Properties (frontmatter)

- YAML frontmatter is the storage format (Obsidian-compatible). P0: parsed, indexed, rendered in Live Preview/Reading as a clean key-value table at note top (raw YAML in Source mode).
- P0 property editor: add/edit/remove typed values — text, list, number, checkbox, date, datetime; type inferred + per-key vault-wide type registry; `tags` and `aliases` are reserved keys feeding §3.3/§3.4.
- P1: autocomplete for known keys and known values; vault-wide Properties view (all keys, counts, bulk rename key); property search operators; date properties get a date-picker.
- Malformed YAML never destroys data: banner "Frontmatter could not be parsed" + raw editing, file untouched.

### 3.8 Daily notes & templates

- **Daily notes (P0):** ⌘⇧D opens/creates today's note. Settings: date format (default `YYYY-MM-DD`), folder, template. Omnibar: "Open daily note", "Previous/Next daily note". Calendar view P2 (community-plugin territory).
- **Templates (P0):** template folder setting; "Insert template" command; variables `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}` (Moment-style tokens for Obsidian familiarity, implemented with `dayjs`). Templater-style scripting is explicitly plugin territory (P2/community).
- **New note defaults (P0):** default location (vault root / same-as-current / fixed folder), default template for new notes (P1), unique-name collision policy `Title 1`.

### 3.9 Graph view

- **Global graph (P1):** nodes = notes (+ ghost nodes for unresolved links toggle, + tags-as-nodes toggle, + attachments toggle), edges = links. WebGL renderer (Pixi.js), d3-force simulation in a Web Worker, positions cached per device for instant reopen. Interactions: pan/zoom (buttery ≥ 50 fps at 20k nodes), hover highlights neighbors + dims rest, click opens note, drag pins node (P2). Controls (Linear-style floating panel, collapsed by default): search/filter query (same operators as §3.6), color groups by query (e.g. `tag:#project` → accent hue), forces sliders (center/repel/link distance), node-size by backlink count toggle, orphans toggle, time-lapse (P2).
- **Local graph (P1):** right-panel tab, depth 1–2 around active note, same renderer.

### 3.10 Canvas

- **P1.** Infinite spatial board stored as `.canvas` files implementing the open JSON Canvas 1.0 spec (round-trips with Obsidian canvases; a fixture corpus of real `.canvas` files gates CI).
- Node types: text card (full Loam editor inline), note embed (live, editable in place P2, click-through P1), image/file, external link card (favicon + title fetch on explicit user action only), group (labeled container). Edges: directional arrows, optional labels, sides + auto-routing (straight/bezier per spec `fromSide/toSide`).
- Interactions: pan (space-drag / trackpad), zoom-to-fit (⇧1), zoom-to-selection (⇧2), multi-select marquee, align/distribute commands, double-click empty → new card, drag note from sidebar → embed card, snap-to-grid toggle, color per node/edge from the 6-color canvas palette (spec-compatible `1`–`6` + hex).
- Renderer decision is a spike (§5.14/S2): custom DOM/CSS-transform layer (default lean, because cards must host the real CM6 editor) vs. `@xyflow/react`.

### 3.11 Obsidian vault compatibility & import (the switching story)

- **P0 — Non-destructive coexistence:** opening a folder that contains `.obsidian/` just works; Loam never reads secrets from nor writes anything into `.obsidian/`. Both apps can be used on the same vault alternately (watcher handles external edits). All Loam vault config lives in `.loam/` (§5.5).
- **P0 — Format compatibility** is the syntax table (§3.3) + link behavior (§3.4) + frontmatter (§3.7) + JSON Canvas (§3.10). Compatibility is verified by a growing corpus of real-world vault fixtures in CI.
- **P1 — Import wizard:** detects `.obsidian/`, offers a one-screen mapping report before doing anything: appearance → Loam theme (dark/light + accent), `app.json` → new-link format, attachment folder, `daily-notes.json` → §3.8 settings, `hotkeys.json` → best-effort keymap mapping (unmappable ones listed), `core-plugins.json` → built-in equivalence table, `community-plugins.json` → report of Loam-registry equivalents ("12 have equivalents, 5 don't yet — vote/build links"). Wizard writes only into `.loam/`; a "Keymap: Obsidian preset" toggle ships regardless of import (P0) so muscle memory (⌘O, ⌘P, ⌘E …) survives.
- **P2 — Importers** for Notion, Roam, Logseq, Evernote (separate first-party plugin, mirroring Obsidian's importer approach).

### 3.12 Settings, hotkeys & appearance

- **Settings (P0):** Linear-style full-height settings surface (⌘,) with left nav: General, Editor, Files & Links, Appearance, Hotkeys, Daily notes, Templates, Core features (toggles for Graph/Canvas/Backlinks etc.), Plugins, About. Every control has a stable `setting-id` (used by tests and the omnibar's "search settings" P1). Vault-shared settings vs. device-local settings are visually badged and stored separately (§5.5).
- **Hotkeys (P0):** every command rebindable; conflict detection inline; search by key or command; presets: *Loam default*, *Obsidian compat*. Default map (mod = ⌘/Ctrl): ⌘K omnibar · ⌘O notes · ⌘P commands · ⌘N new note · ⌘⇧N new window · ⌘T/⌘W/⌘⇧T tabs · ⌃Tab cycle · ⌘1–9 tab n · ⌘\ split right · ⌘E edit/read · ⌘F find · ⌘⌥F replace · ⌘⇧F search vault · ⌘⇧D daily note · ⌘[ ⌘] back/forward · ⌘, settings · ⌘B/⌘I bold/italic · ⌘⇧X strike · ⌘L toggle task · ⌘⇧E reveal in file tree · ⌘. toggle right panel · ⌘⇧. toggle left sidebar · F2 rename.
- **Appearance (P0):** theme = Loam Dark (default) / Loam Light / follow system; accent color picker (token-driven, §4.2); UI density (default/compact P1); editor font family/size/line-width; interface zoom. Community themes + CSS snippets P1 (§5.8).

### 3.13 Plugins (product level — technical architecture in §5.7)

- **P1:** Plugin manager in settings: browse the community registry in-app (search, sort by downloads/updated, screenshots, README render), install/update/uninstall, per-plugin enable toggle, per-plugin settings tabs. Declared permissions shown at install (vault read/write is implicit; `network`, `clipboard` are called out). "Restricted mode" master switch (default ON for fresh vaults: no community code runs until the user opts in — Obsidian-familiar behavior).
- **First-party reference plugins (P1, separate repos, MIT):** `sample-plugin` (template + docs), `word-count-plus` (status-bar/API demo), `kanban` (code-block-processor + view demo). These exist to prove and document the API, and are built only through the public API.
- **Community registry (P1):** `loam-plugins` GitHub repo: PR-based submission, automated checks (manifest validity, semver, size cap, no `eval`/`new Function`, permission honesty heuristics, license present), human review for first submission, signed index JSON consumed by the app.

### 3.14 Sync & mobile (posture and roadmap)

- **P0 posture:** be the best-behaved app in a synced folder. Atomic writes, tolerant watcher (handles Syncthing/Dropbox/iCloud tempfile churn), conflict-copy detection (`Note (conflicted copy…)` surfaced with a merge/diff UI P1), iCloud dataless-file materialization on macOS, "vault is read-only" graceful mode. Docs: first-class guides for Git, Syncthing, iCloud, Dropbox.
- **P2 — Loam Sync v0:** optional self-hosted server (single Rust binary + SQLite), E2E encrypted (libsodium sealed vault key; server sees ciphertext only), file-level last-writer-wins with automatic conflict copies (no CRDTs in v0 — §5.14/S3 spikes CRDT adoption for v1 of sync). Device pairing via QR/words.
- **P2 — Mobile:** iOS/Android via Tauri 2 mobile targets, same Rust core and IPC contract, reduced UI (browse/search/edit/daily/omnibar). Community plugins on mobile follow Obsidian's precedent but are validated against store policy during the epic (risk register §8).
- **P2 — Web clipper:** MV3 browser extension → clean Markdown into inbox folder via URI/local bridge.

### 3.15 Explicit exclusions (do not ticket)

Real-time collaboration; hosted SaaS; Bases-style database views (post-1.0 evaluation); publish-to-web service (post-1.0; static-export command P2 is the stopgap); email/task integrations; AI assistants in core; per-block comments; PDF annotation.

---

## 4. Design system — the Linear treatment

This section is normative. Implementation lives in `packages/ui` as CSS custom properties + React primitives; themes may only override documented `--loam-*` tokens (§5.8). Values below are our own, designed in the *spirit* of Linear (dark-first, LCH-tuned neutrals, one desaturated indigo accent, dense type, fast subtle motion) — not copies of Linear's assets.

### 4.1 Principles

1. **Fast is beautiful.** Motion exists to explain state changes, never to entertain. Nothing bounces. Nothing takes longer than 200 ms.
2. **Chrome recedes, text advances.** UI text is small, quiet, and mid-contrast; *note* text is generous and high-contrast. The user's writing is always the brightest thing on screen.
3. **Borders over shadows** for structure; shadows only for true elevation (popovers, modals).
4. **Sentence case everywhere.** No Title Case, no exclamation marks, no ellipsis abuse (… only when a further choice follows).
5. **Hover reveals, never rearranges.** Affordances (fold chevrons, row actions, drag handles) fade in on hover without shifting layout.
6. **Signature element:** the omnibar (⌘K). It is the product's front door and the single most polished surface — first paint of results < 50 ms, per-keystroke updates < 30 ms, and it visibly *is* the brand.

### 4.2 Foundations (tokens)

**Color — Loam Dark (default).** Neutrals are near-achromatic with a barely-warm cast; generated on an LCH ramp so steps are perceptually even.

```css
:root[data-theme="dark"] {
  --loam-bg-app:        #0B0C0F;  /* window base            */
  --loam-bg-panel:      #101216;  /* sidebars, panels        */
  --loam-bg-raised:     #16181D;  /* cards, inputs, hovers   */
  --loam-bg-overlay:    #1C1F26;  /* popovers, omnibar       */
  --loam-bg-hover:      rgba(255,255,255,0.045);
  --loam-bg-active:     rgba(255,255,255,0.08);
  --loam-bg-selected:   rgba(112,126,232,0.14);
  --loam-border-subtle: rgba(255,255,255,0.06);
  --loam-border:        rgba(255,255,255,0.10);
  --loam-border-strong: rgba(255,255,255,0.16);
  --loam-text-primary:  #EEEFF3;
  --loam-text-secondary:#9EA3AE;
  --loam-text-tertiary: #686E7A;
  --loam-text-disabled: #4A4F58;
  --loam-accent:        #707EE8;  /* Loam iris               */
  --loam-accent-hover:  #8590EE;
  --loam-accent-text:   #A6AEF6;  /* links on dark           */
  --loam-accent-subtle: rgba(112,126,232,0.14);
  --loam-success:       #3FB57F;
  --loam-warning:       #D9A13C;
  --loam-danger:        #E5544C;
  --loam-highlight:     rgba(217,161,60,0.28); /* ==marks== */
}
```

**Loam Light** mirrors the ramp: `--loam-bg-app:#FAFAFB`, `--loam-bg-panel:#FFFFFF`, raised `#FFFFFF` with `--loam-border: rgba(0,0,0,0.09)`, subtle `rgba(0,0,0,0.06)`, text `#1B1D22 / #5F6570 / #9096A1`, accent deepened to `#5D6BDF` for AA contrast, selected `rgba(93,107,223,0.10)`. All text/background pairs must pass WCAG AA (4.5:1 body, 3:1 large/secondary-UI); a CI contrast test walks the token pairs.

**Typography.** UI face **Inter** (OFL; variable font, `font-feature-settings: "cv05","tnum" 0` — tabular nums only in tables/counters). Mono **JetBrains Mono** (OFL). Editor face defaults to Inter with an optional bundled serif (**Source Serif 4**, OFL) and system-font choice.

| Role | Size/line | Weight |
|---|---|---|
| UI micro (badges, shortcut hints) | 11.5/16 | 500 |
| UI secondary (metadata, panel labels) | 12.5/18 | 450 |
| UI base (menus, sidebar, inputs) | 13/20 | 450 |
| UI emphasis (active items, buttons) | 13/20 | 550 |
| Panel titles | 15/22 | 600 |
| Editor body (default, user-adjustable 14–20) | 16/1.65 | 400 |
| Editor headings | H1 1.55em/650 · H2 1.30em/650 · H3 1.15em/600 · H4–H6 1.0em/600 (H5 secondary color, H6 tertiary) | |

Editor measure: max-width 46rem centered ("readable line length" toggle, on by default). Code blocks 13.5px mono on `--loam-bg-raised` with a hover-revealed copy button and language chip.

**Spacing & radii.** 4 px grid: 2, 4, 6, 8, 12, 16, 20, 24, 32, 40. Radii: 4 (inputs, chips) · 6 (buttons, list rows) · 8 (popovers, cards) · 10 (modals). Sidebar row height 28 px; menu row 30 px; omnibar row 40 px.

**Elevation.** Popover: `0 8px 24px rgba(0,0,0,0.42)` + 1 px `--loam-border`. Modal: `0 16px 48px rgba(0,0,0,0.55)` over a `rgba(0,0,0,0.5)` scrim (light theme: 0.35/0.25). Nothing else casts shadows.

**Motion.** Durations: `--dur-fast: 100ms` (hover, press), `--dur-base: 140ms` (popovers, tooltips, tab switch), `--dur-slow: 200ms` (panels, modals). Single easing: `cubic-bezier(0.2, 0, 0, 1)`. Entrances: fade + 4 px translate (popovers from their anchor side; modals scale 0.98→1). `prefers-reduced-motion` collapses all motion to opacity ≤ 80 ms. No skeleton shimmer — static placeholders.

### 4.3 Component inventory (build order in E07)

Buttons (primary/secondary/ghost/danger; 28 px; icon-buttons 26 px) · Inputs, textarea, search field (with inline ⌘-hint) · Select, combobox · Checkbox, switch, radio (13 px controls) · Menu & context menu (with shortcut column, submenu flyouts, type-ahead) · Tooltip (delay 400 ms, instant when moving between targets; shows shortcut) · Popover · Modal & confirm dialog · Toast (bottom-right, max 3 stacked, action button, 5 s auto-dismiss, hover pauses) · Tabs (app-level and panel-level) · Tree (file explorer: virtualized, drag-drop, inline rename) · List row & result row (omnibar/search share one) · Breadcrumb · Badge/chip (tags, counts) · Segmented control · Slider · Kbd glyph · Empty state (one line + one action, per §4.5) · Progress (thin 2 px accent bar, indeterminate only for network) · Split-pane resizer (4 px hit area, accent line on drag) · Virtualized list utility (TanStack Virtual) used by tree, search, backlinks, omnibar.

All primitives are built on **Base UI** headless components (a11y, focus management) + **Floating UI** positioning, styled exclusively with the tokens above. Storybook (or Ladle) hosts every component with visual-regression snapshots per theme (§5.12).

### 4.4 Interaction patterns

- **Omnibar:** centered top-third overlay, 560 px wide, blurred scrim (none if reduced-transparency), input 15 px, grouped results with left icons and right shortcut/detail column, ↑↓ navigate ⏎ open ⌘⏎ open-in-new-tab ⇥ into submenu. Frecency-ranked *Recent* section when query is empty.
- **Peek:** link previews (§3.4) and omnibar ⌘-hover previews share one popover component; max 420×480 px, scrollable, renders through the standard Reading pipeline.
- **Drag & drop:** file-tree moves, tab reordering, drag-tab-to-split, drag-note-to-canvas/editor (inserts link), OS-file drag-in (imports attachment). One drop-indicator style everywhere: 2 px accent line / accent-tinted target.
- **Selection model:** file tree and search results support ⌘-click multi-select and ⇧-range; context menus operate on selection.
- **Errors:** inline and specific ("Couldn't rename: a file named 'Ideas.md' already exists"), never modal unless data-destructive; toasts carry an action when one exists ("Open folder", "Retry").
- **First-run:** no wizard. A single screen: "Open folder" / "Create new vault" / drag-target; then an optional 5-item interactive checklist note ("Welcome to Loam") created inside the new vault.

### 4.5 Voice & microcopy

Plain verbs, sentence case, no filler, no exclamation marks, no "please". The interface never says "please wait", apologizes, or emotes. Buttons say what they do ("Rename 143 links", not "Confirm"). Empty states are invitations: Backlinks → "No linked mentions yet. Link to this note with [[Note name]]." Errors state cause + remedy. The word "vault" is retained (community vocabulary); "note" not "document"; "omnibar" is internal — the UI just shows the surface.

### 4.6 Accessibility (P0, enforced in CI)

Full keyboard operability (every interactive element reachable and operable; visible 1.5 px accent focus ring, `:focus-visible` only); correct ARIA on tree/tabs/menus/dialogs via Base UI; screen-reader labels on icon buttons; WCAG 2.2 AA contrast; reduced-motion + reduced-transparency honored; UI zoom 90–150 %; RTL layout smoke-tested (M6); CM6 configured for screen-reader announcements and IME correctness (CJK input is a release blocker, tested in CI fixtures).

---

## 5. Architecture

### 5.1 Shape of the system

```
┌─────────────────────────── Desktop / Mobile app ───────────────────────────┐
│  WebView UI — TypeScript + React 19                                        │
│  ┌──────────┐ ┌───────────────┐ ┌──────────────┐ ┌──────────────────────┐  │
│  │ App shell│ │ Editor (CM6)  │ │ Views: graph │ │ Plugin runtime (JS)  │  │
│  │ panes/UI │ │ live preview  │ │ canvas, search│ │ public API surface  │  │
│  └────┬─────┘ └──────┬────────┘ └──────┬───────┘ └─────────┬────────────┘  │
│       └───────────── typed IPC (tauri-specta) ─────────────┘               │
├────────────────────────────────────────────────────────────────────────────┤
│  Tauri 2 shell (Rust) — windows, menus, fs scope, updater, deep links      │
│  ┌──────────────────────── crates/loam-core ────────────────────────────┐  │
│  │ vault fs + atomic writer + watcher (notify)                          │  │
│  │ markdown parse (comrak + extensions)  →  index (SQLite/rusqlite)     │  │
│  │ full-text search (tantivy) · fuzzy (nucleo) · link graph (petgraph)  │  │
│  │ history/snapshots · import · URI handling                            │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
         Markdown files on disk = source of truth · all indexes rebuildable
```

The UI never touches the filesystem directly; everything crosses the typed IPC boundary. This keeps the contract identical for desktop and mobile, makes the frontend testable in a plain browser with a mocked transport, and concentrates all trust decisions in Rust.

### 5.2 Decision records (summary ADRs — copy into `/docs/adr/` as ADR-001…)

**D1 — Shell: Tauri 2 (not Electron).** Rationale: (a) the Rust core is the product's performance moat — indexing, search, and link rewriting in native code with real threads; (b) 2026 consensus is Tauri-by-default for new apps — sub-30 MB installers, a fraction of Electron's memory, capability-based security where the webview only reaches what we grant; (c) Tauri 2's iOS/Android targets reuse the same core and IPC contract, where Obsidian must maintain a separate Capacitor app; (d) positioning — "not another Electron app" is a differentiator this community responds to. *Eyes-open cost:* system webviews differ (WebView2/Chromium on Windows, WKWebView on macOS/iOS, WebKitGTK on Linux), which matters for an app with community themes. Mitigations are a standing program, §5.11. Electron remains the documented fallback; the IPC-only frontend keeps a port feasible if the bet sours (revisit trigger: a webview bug class we cannot mitigate within one release).

**D2 — UI: React 19 + TypeScript (strict).** Largest contributor pool, mature ecosystem, React Compiler removes the classic perf footguns, and the editor pane is framework-agnostic CM6 anyway. Svelte 5/Solid were considered and rejected on contributor-funnel grounds alone. State: **Zustand** stores per domain (vault, workspace, settings, search) — minimal, unopinionated, easily testable; no Redux, no server-state lib (there is no server).

**D3 — Editor: CodeMirror 6.** The only editor purpose-built for "Markdown source is the document" with decoration-based live preview at scale; modular, actively maintained, excellent IME/a11y story, and the same foundation Obsidian plugin authors already know (eases plugin porting). ProseMirror/Lexical/Milkdown rejected: rich-text-first models that round-trip Markdown lossily.

**D4 — One Markdown grammar: comrak.** comrak (CommonMark + GFM + footnotes + math + wikilinks + alerts/callouts + frontmatter options) is used natively for indexing and compiled to WASM for the Reading view, so index and render can't drift. Live Preview uses Lezer's incremental Markdown parser (a CM6 requirement) with matching extensions; the shared fixture corpus (§3.3) is the conformance contract. Custom comrak extension work needed: `==highlight==`, `%%comments%%`, block IDs, embed syntax — budgeted in E03.

**D5 — Index: SQLite (rusqlite, bundled) as derived cache.** Files are truth; `index.db` (files/links/tags/properties/headings/blocks/aliases tables, §5.5) is disposable and rebuilt on schema bump or corruption. Single writer thread; readers via connection pool; migrations via `rusqlite_migration`.

**D6 — Search: tantivy** (full-text; per-field boosts title > headings > body > tags) **+ nucleo** (switcher fuzzy matching, the Helix editor's matcher). Regex search bypasses tantivy with a parallel `grep`-style scan in core.

**D7 — Watcher: notify + debouncer**, with polling fallback for network drives; event pipeline normalizes editor-originated vs. external changes by content hash.

**D8 — Component layer: Base UI + Floating UI + Lucide icons (16 px/1.5 px) + cmdk-pattern omnibar (own implementation on Base UI listbox) + TanStack Virtual.** All MIT/ISC.

**D9 — Graph: Pixi.js v8 (WebGL/WebGPU) + d3-force in a Web Worker.** Sigma.js considered (viable alternate); tldraw rejected for canvas on license grounds (§1.5). **Canvas: JSON Canvas 1.0 format; renderer spike §5.14/S2.**

**D10 — Tooling: pnpm workspaces + Turborepo; Vite; Vitest; Playwright; Biome (lint+format TS); cargo workspace + clippy + rustfmt + cargo-nextest; cargo-deny + license-checker; Renovate with grouped weekly updates; Conventional Commits + release-please.**

**D11 — Rendering extras:** Shiki for Reading-view code (worker + cache), KaTeX for math, Mermaid lazy-loaded, DOMPurify for HTML passthrough, dayjs for date tokens. All lazy where heavy; cold path must not pay for them (§5.9).

**D12 — Licensing: app + core AGPL-3.0-only; `plugin-sdk`, theme starter, and fixtures MIT; DCO (no CLA).** AGPL blocks proprietary strip-mining and closed SaaS forks (Logseq precedent); MIT SDK keeps plugin authors unencumbered — their code links only against MIT types and a runtime API, and plugins may use any license.

### 5.3 The core crate (`crates/loam-core`)

Modules: `vault` (open/close, fs ops, atomic writer, trash, attachment import) · `watch` (notify pipeline → normalized `VaultEvent`s) · `parse` (comrak config, extension set, extraction of links/tags/props/headings/blocks) · `index` (SQLite schema, incremental update, rebuild) · `search` (tantivy lifecycle, query language parser, snippets; nucleo switcher) · `links` (resolution rules, rename-rewrite planner/applier) · `graph` (petgraph snapshot builder, filters) · `history` (snapshot store, prune) · `import` (Obsidian config mapping) · `uri` (deep-link parsing). No Tauri types leak into `loam-core` — it is a pure library with its own test suite and a thin `loam-cli` (P2, dev tool: `loam-cli index|search|lint` against any vault) that doubles as a headless test harness.

### 5.4 IPC contract (typed via specta + tauri-specta → generated TS client)

Representative commands (full list grows in E06; every command returns `Result<T, LoamError>` with a stable error enum):

```rust
vault_open(path) -> VaultInfo               // id, root, counts, index status
note_read(path) -> NoteDoc                  // content, hash, meta
note_write(path, content, base_hash) -> WriteResult
  // base_hash mismatch => Err(Conflict{disk_hash}) — UI shows merge banner
note_create(folder, title, template_id?) -> NoteRef
rename_plan(path, new_path) -> LinkRewritePlan   // affected files + previews
rename_apply(plan_id) -> RewriteReport
search(query, filters, limit, cursor) -> SearchPage
switcher(query, limit) -> Vec<SwitchHit>         // nucleo-ranked, frecency-boosted
backlinks(path) -> Vec<Mention>                  // grouped, with snippet ranges
graph_snapshot(filter) -> GraphData              // nodes/edges, capped + paged
props_query(key?, value?) -> …    tags_list() -> …    history_list(path) -> …
```

Events (webview subscribes): `vault://file-changed{path,kind,origin}`, `vault://index-progress{done,total}`, `vault://conflict{path}`, `app://update-available`. Payloads are JSON now; a MessagePack/raw-IPC upgrade for `graph_snapshot`/`search` is a measured optimization, not a default.

### 5.5 Data layout & the shared/local split (an explicit fix for Obsidian's sync noise)

- **In the vault (syncs with the user's files):** notes, attachments, `.canvas` files, and `.loam/` containing only *intentional, shareable* config: `settings.json` (vault-scoped settings), `templates/` config, `themes/<id>/`, `snippets/*.css`, `plugins/<id>/` (code + `data.json`), `plugins.json` (enabled list).
- **Per device (OS app-data dir, keyed by vault id):** `index.db`, `search/` (tantivy), `workspace.json` (window/tab layout), `history/` (file recovery snapshots), `graph-cache.json`, device overrides (e.g. per-device disabled plugins). Result: opening the same vault on two machines never causes config-file sync churn, and caches never pollute Git diffs.
- Vault identity: `.loam/vault.json` `{ id: uuid, createdAt }` — the only file Loam creates unprompted, written on first explicit "use this folder" confirmation.

### 5.6 File-handling rules (binding)

Atomic writes (same-dir tempfile → fsync → rename; fsync dir on POSIX). Conflict detection via `base_hash` on every write (§5.4). External-change while buffer clean → silent reload preserving cursor; while dirty → non-blocking banner with side-by-side diff, "Keep mine / Take disk / Merge manually" — never a data-losing modal. Deletes to OS trash (`trash` crate). Unicode paths normalized NFC internally, NFD round-tripped on macOS. Case-insensitive-fs collision detection with actionable error. Windows long paths via `\\?\`. Symlinks followed with cycle guard; junctions treated as symlinks. Files > 2 MB: Source-mode-only notice; > 20 MB: not indexed for FTS (metadata only) with per-file override. Dataless/placeholder cloud files (iCloud/OneDrive) detected and materialized on open with progress. Read-only vaults open in reading mode with a banner. Watcher falls back to 2 s polling when native events are unavailable (network mounts).

### 5.7 Plugin architecture (technical)

- **Model (v1): trusted code, honest UX** — the Obsidian/VS Code model, stated plainly in docs: community plugins run with app privileges inside the webview; safety comes from Restricted-mode default, registry review + automated checks, declared permissions surfaced at install, and Tauri's native-side capability scoping (the webview itself can only reach vault-scoped fs and granted APIs — a plugin cannot exec processes or read outside the vault via our IPC). The API is async-first and handle-based so a worker-isolation mode can be introduced later without breaking authors (§5.14/S4).
- **Loading:** plugins are ES modules under `.loam/plugins/<id>/` with `manifest.json` `{ id, name, version, minAppVersion, description, author, permissions[], main }`; loaded via dynamic import with a per-plugin scoped `LoamAPI` instance; all `register*` calls auto-dispose on unload; hot enable/disable without restart.
- **API namespaces (`@loam/plugin-sdk`, MIT, semver'd independently):** `app.vault` (CRUD + events) · `app.metadata` (resolved links/tags/props/headings cache) · `app.workspace` (open, panes, active note, `registerView(type, factory)`) · `app.commands.register` (auto-listed in omnibar + hotkeys) · `app.omnibar.registerProvider` · `app.settings.registerTab` + `plugin.data` (JSON store) · `app.ui` (status-bar items, context-menu contributions, toasts) · `editor.registerExtension(cm6Extension)` · `markdown.registerPostProcessor(fn)` and `markdown.registerCodeBlockProcessor(lang, fn)` · `net.fetch` (only with `network` permission; CSP-enforced) · `uri.registerHandler`.
- **Versioning:** `minAppVersion` gate + runtime API-version constant; deprecations warned one minor ahead; breaking API changes only at app majors, with a published migration note. Public API surface is snapshot-tested — accidental breakage fails CI.

### 5.8 Theming

Themes override documented `--loam-*` tokens via `theme.json` (structured, validated) and may append `theme.css` for advanced cases; snippets are raw CSS toggles. The token contract (§4.2) is the *only* stable selector API — DOM structure/classes are explicitly not stable, and docs say so. Community themes go through the same registry pipeline as plugins. Live-reload in a "theme dev mode".

### 5.9 Performance SLOs (product requirements, enforced by `loam-bench` in CI on Linux runners + weekly on real macOS/Windows hardware; regression gate ±10 %)

Reference vaults: `bench-1k`, `bench-10k`, `bench-100k` (synthetic, generated deterministically) on 2021-class hardware.

Cold start → interactive p50 < 900 ms, p95 < 1.5 s · open cached note < 80 ms · keystroke p95 < 16 ms @10k-word doc · omnibar open < 50 ms, per-keystroke < 30 ms · vault search p95 < 150 ms @100k · initial index 10k notes < 10 s (progress UI, app usable meanwhile), incremental reindex single file < 30 ms · rename rewriting 500 inbound links < 1.5 s · graph 20k nodes ≥ 50 fps pan/zoom after settle · typical session memory < 400 MB @10k vault · installer < 30 MB. Startup discipline: no KaTeX/Mermaid/Shiki/graph code on the cold path (route-level code-splitting is asserted by a bundle-budget CI check).

### 5.10 Security & privacy

Tauri capabilities: fs scoped to opened vault roots + app-data; no shell-exec capability shipped; CSP default-deny with `net.fetch` proxied through core for permissioned plugins; updater artifacts signed (Tauri updater keys) plus OS signing/notarization (E26 covers certs, macOS notarization, Windows signing via Azure Trusted Signing). HTML rendering sanitized (D11). No telemetry by default; opt-in anonymous crash reporting only (self-hosted Sentry-compatible endpoint, documented payloads, kill switch in settings). Threat-model doc in `/docs/security.md`; `SECURITY.md` with disclosure policy from day one.

### 5.11 Cross-platform & webview program (the standing Tauri mitigation)

Support matrix: macOS 12+ (Intel/AS), Windows 10 1809+/11 (WebView2 evergreen), Ubuntu 22.04+/Fedora (WebKitGTK 2.42+; AppImage, deb, rpm, Flatpak; note WebKitGTK floor in docs). Playbook: (1) CSS discipline — tokens + autoprefixer + a lint deny-list for known-divergent features; (2) per-platform visual-regression screenshots of 20 golden screens in CI; (3) feature-detect not UA-sniff, with graceful degradation (e.g. `backdrop-filter` → solid overlay); (4) Linux perf watch — WebKitGTK is the weakest link; the graph/canvas epics include explicit Linux perf sign-off; (5) a documented Electron-port escape hatch (D1) that the IPC boundary keeps honest.

### 5.12 Testing strategy

- **Rust:** unit + property tests (proptest for link-rewrite and path edge cases); fixture-corpus conformance for parsing (§3.3) and JSON Canvas; index rebuild determinism test; cargo-nextest in CI.
- **TS unit/component:** Vitest + Testing Library; every `packages/ui` primitive has interaction + axe (a11y) tests; visual regression via Storybook/Ladle snapshots per theme per platform.
- **Integration:** frontend runs in real browsers under Playwright with a mocked IPC transport implementing the full contract (the generated types make the mock cheap and honest); covers flows: create→link→rename→backlinks, search, omnibar, conflict banner, import wizard.
- **Native e2e:** thin smoke suite via tauri-driver (Windows/Linux; macOS lacks WebDriver — covered instead by the weekly real-hardware manual+scripted checklist, and this gap is accepted and documented).
- **Perf:** `loam-bench` harness (§5.9) as its own crate/package, run per-PR (Linux) with trend dashboards.
- Coverage gates: `loam-core` ≥ 85 % line, `packages/ui` ≥ 80 %; AI-authored PRs must include tests for every AC (§6.3) — CI blocks otherwise.

### 5.13 Repository & delivery

```
loam/
  apps/desktop/           # Tauri shell (src-tauri) + React app (src)
  crates/loam-core/       # engine (pure lib)
  crates/loam-bench/      # perf harness
  packages/ui/            # tokens + primitives + stories
  packages/plugin-sdk/    # MIT — public API types + docs
  packages/markdown-wasm/ # comrak wasm bindings
  packages/ipc-client/    # generated bindings + browser mock transport
  fixtures/               # markdown corpus, canvas corpus, bench vault generators
  docs/                   # Starlight site: user docs, plugin dev docs, ADRs
  .github/                # CI, issue templates, release automation
```

CI (GitHub Actions): lint/format (Biome, clippy, rustfmt) → tests (matrix: ubuntu/mac/windows) → license audit → bundle budget → perf (linux) → build artifacts. Release: release-please version PRs; tags trigger tauri-action matrix builds, signing, notarization, updater-manifest publish; canary channel from `main`, stable monthly-ish. Auto-update via Tauri updater with staged rollout percentage.

### 5.14 Deferred decisions (pre-created spike tickets; each is 1–2 days, output = ADR)

S1 Property/table "Bases-lite" direction (post-1.0 discovery only) · S2 Canvas renderer: custom DOM vs @xyflow/react (prototype both against `.canvas` fixtures + perf on Linux) · S3 Sync v1 CRDT evaluation: Loro vs Automerge vs yrs (Rust bindings, file-format implications) — sync v0 ships LWW+conflict-copies regardless · S4 Plugin worker-isolation feasibility (API impact assessment) · S5 Mobile plugin policy validation against current App Store guidelines · S6 Windows-on-ARM build viability.

---

## 6. Delivery plan

### 6.1 Milestones (sequence-based; calendar durations depend on agent cadence — exit criteria are the contract)

| M | Name | Exit criteria |
|---|---|---|
| M0 | Foundation | Monorepo + CI green on 3 OS; Tauri shell boots < 1 s; open vault, file tree, open/edit/save note (Source mode) with atomic writes; watcher reflects external edits; signed dev builds produced by CI. |
| M1 | Daily driver | Live Preview for the core inline set (headings/emphasis/lists/tasks/quotes/code); wikilinks with autocomplete; backlinks panel; omnibar (notes + commands + create); tabs/splits + history; rename→link-rewrite with preview; find-in-note; settings + hotkeys (both presets); dark/light themes; frontmatter rendered. The build team dogfoods full-time; M1 SLO subset green (start, keystroke, omnibar). |
| M2 | Knowledge core | Full §3.3 P0 table (embeds, callouts, math, tables, comments, highlights); global search + operators; properties editor; templates + daily notes; attachments/paste; page preview; outline + tags panes; bookmarks; import wizard v1 + Obsidian keymap; file recovery. An Obsidian text-vault user switches losslessly for text workflows; compat fixture corpus green. |
| M3 | Extensible | Plugin runtime + SDK v1 + manager + registry pipeline live; 3 first-party reference plugins built purely on the public API; theme system + registry; API snapshot tests. External developer can build/ship a plugin with docs alone; ≥ 10 community plugins listed. |
| M4 | Spatial | Global + local graph at SLO; Canvas v1 passing JSON Canvas round-trip fixtures; PDF/HTML export of notes. |
| M5 | Everywhere | Mobile alpha (iOS TestFlight / Android APK): browse, edit, search, daily, omnibar on same core; sync posture hardening shipped (conflict-copy UI); Sync v0 self-host beta (LWW + E2E) with deployment guide; URI scheme; web clipper beta. |
| M6 | 1.0 | All SLOs green on all platforms; WCAG 2.2 AA audit pass; i18n extraction + 3 seed locales + RTL smoke; security review of plugin runtime + updater; crash-free sessions ≥ 99.5 % over 4 canary weeks; docs complete; launch checklist done. |

### 6.2 Epic catalog (Linear project per epic; `→` = depends on)

| ID | Epic | M | Goal (one line) | → |
|---|---|---|---|---|
| E00 | Monorepo, tooling, CI/CD skeleton | M0 | §5.13 layout, all gates wired, artifact builds | — |
| E01 | Tauri shell & windows | M0 | Window mgmt, titlebar, menus, deep-link plumbing, capabilities | E00 |
| E02 | Core: vault fs, atomic IO, watcher | M0 | §5.6 rules implemented + property-tested | E00 |
| E03 | Core: Markdown parsing & extraction | M0 | comrak config + custom extensions + fixture corpus | E00 |
| E04 | Core: SQLite index | M0 | Schema, incremental updates, rebuild, migrations | E02,E03 |
| E05 | Core: search & switcher | M1 | tantivy lifecycle, query language, nucleo + frecency | E04 |
| E06 | IPC contract & generated client | M0 | specta types, error enum, browser mock transport | E02 |
| E07 | Design system package | M0 | §4.2 tokens + §4.3 primitives + stories + a11y tests | E00 |
| E08 | App shell UI | M1 | Sidebars, file tree, tabs/splits, status bar, right panel | E06,E07 |
| E09 | Editor foundation (CM6) | M1 | Source mode, find/replace, editing behaviors §3.2 | E06 |
| E10 | Live Preview | M1–M2 | Decoration engine per syntax family, widgets, perf | E09,E03 |
| E11 | Links engine UX | M1 | Autocomplete, resolution, rename-refactor, backlinks | E05,E09,E08 |
| E12 | Omnibar, commands, hotkeys | M1 | §3.5 surface + presets + conflict detection | E07,E08 |
| E13 | Global search UI | M2 | §3.6 view, operators, snippets | E05,E08 |
| E14 | Properties | M2 | §3.7 render/editor/registry | E10,E04 |
| E15 | Attachments & media | M2 | Paste/drag pipeline, viewers, embeds AV | E02,E10 |
| E16 | Templates & daily notes | M2 | §3.8 complete | E09 |
| E17 | Reading view & export | M2/M4 | WASM render pipeline, Shiki/KaTeX/Mermaid, PDF/HTML export | E03 |
| E18 | Import & Obsidian compat | M2 | Wizard, keymap preset, coexistence tests | E11,E12 |
| E19 | History / file recovery | M2 | Snapshots, timeline UI, restore/diff | E02 |
| E20 | Plugin platform | M3 | Runtime, SDK, manager, registry pipeline, reference plugins | E08–E12 |
| E21 | Theming | M3 | theme.json engine, snippets, dev mode, registry | E07 |
| E22 | Graph | M4 | §3.9 global+local at SLO | E04,E08 |
| E23 | Canvas | M4 | §3.10 + JSON Canvas fixtures (spike S2 first) | E10 |
| E24 | Mobile | M5 | Tauri mobile targets, reduced UI, store pipeline | E06–E12 |
| E25 | Sync v0 | M5 | Self-host server, E2E, LWW+conflict copies, pairing | E02 |
| E26 | Release, signing, updater | M0–M6 | Certs, notarization, channels, staged rollout | E00 |
| E27 | Docs site & guides | M1–M6 | Starlight site: user, plugin-dev, sync guides | E00 |
| E28 | A11y & i18n hardening | M6 | Audit fixes, extraction, locales, RTL | most |
| E29 | Perf bench & budgets | M0–M6 | loam-bench, CI gates, dashboards | E00 |

### 6.3 Ticket conventions (schema — copy verbatim into every Linear issue)

- **Title:** verb-first, ≤ 70 chars ("Implement atomic write pipeline with conflict detection").
- **Fields:** Epic/project, Milestone, Labels (`area:core|editor|ui|shell|plugins|design|infra|docs`, `platform:*` if specific, `decision-needed` when applicable), Size **S** (≤ ½ day) / **M** (≤ 1 day) — L must be split.
- **Body sections, in order:** *Context* (2–3 sentences + spec § reference) · *Scope* (checklist) · *Out of scope* · *Interfaces* (copied verbatim from this doc where defined) · *Acceptance criteria* (numbered, each independently verifiable) · *Test plan* (which suites, which fixtures; every AC maps to ≥ 1 test) · *Perf/A11y notes* (if a §5.9 budget or §4.6 rule applies, restate it) · *Dependencies* (issue IDs).
- **Definition of Done (global):** code + tests merged behind green CI; coverage gates hold; docs updated if user-facing; no new lint suppressions without justification; screenshots/recordings attached for UI work (all themes); changelog entry (release-please conventional commit).

### 6.4 Worked example tickets (the pattern to match)

**T-A · E02 · "Implement atomic write pipeline with conflict detection" · Size M · area:core**
*Context:* All note writes must be crash-safe and detect concurrent external edits (§5.4, §5.6). *Scope:* `vault::writer` — tempfile-in-same-dir → fsync → rename → dir fsync (POSIX); `note_write(path, content, base_hash)`; content-hash helper (blake3); emit normalized `FileChanged{origin: App}`. *Out of scope:* conflict UI (E08), history snapshots (E19). *Interfaces:* `note_write` signature and `Err(Conflict{disk_hash})` per §5.4. *AC:* (1) killing the process at any point during write never leaves a truncated/partial note (fault-injection test); (2) write with stale `base_hash` returns `Conflict` and leaves disk untouched; (3) successful write emits exactly one app-origin change event; (4) works on paths with NFC/NFD variants and Windows `\\?\` long paths (fixtures). *Test plan:* proptest over path corpus; fault-injection unit tests; cross-platform CI matrix.

**T-B · E11 · "Wikilink autocomplete popup" · Size M · area:editor**
*Context:* Typing `[[` opens ranked suggestions (§3.4); this is a top-5 daily interaction and must hit omnibar-class latency. *Scope:* CM6 extension: trigger on `[[`/`![[`, query via `switcher` IPC, popup using shared result-row primitive; keyboard nav; alias pipe insertion `[[Note|`; "Create 'X'" row for unresolved; `#` continuation lists headings of the selected note. *Out of scope:* block refs (`^`, later story), embed preview. *Interfaces:* `switcher(query, limit)` §5.4. *AC:* (1) popup visible < 50 ms after second `[`; (2) results update ≤ 30 ms/keystroke on bench-10k (mocked-IPC perf test + bench assertion); (3) Enter inserts closing brackets and places cursor after them; Esc restores literal typing; (4) fully keyboard operable; screen reader announces option count (axe + manual script); (5) works identically in Live Preview and Source. *Test plan:* Vitest component tests (mock transport), Playwright flow, loam-bench editor scenario.

**T-C · E07 · "Token system + Button/Menu primitives" · Size M · area:design**
*Context:* First slice of §4.2/§4.3; everything downstream consumes it. *Scope:* CSS custom-property tokens for both themes exactly as §4.2; `<Button>` (4 variants, sizes, loading, icon), `<Menu>`/`<ContextMenu>` (shortcut column, submenu, type-ahead) on Base UI; stories for every state × theme. *AC:* (1) token values byte-match §4.2; (2) CI contrast test passes all documented pairs; (3) menus fully keyboard/ARIA correct (axe clean); (4) visual snapshots recorded for both themes; (5) no component ships a hardcoded color (lint rule added). 

### 6.5 Generation algorithm (run this, ticket-AI)

1. Create Linear projects for every epic in §6.2 with its goal line and dependencies noted.
2. For M0 and M1 epics, decompose into S/M stories using §3–§5 as the source of scope; copy interfaces/ACs verbatim where the spec defines them; write the rest in the same style as §6.4.
3. Wire blocking relations along §6.2 dependencies and within-epic sequence.
4. Create the six spike issues from §5.14 immediately (they are unblocked).
5. Create standing issues: E26 signing-cert acquisition (human task, flagged `human-needed`); E00 repo bootstrap; §9.5 trademark checklist (human, `human-needed`).
6. Anything ambiguous → `decision-needed` issue per §0.2. Do not silently choose.
7. On milestone completion, repeat step 2 for the next milestone (rolling wave).

---

## 7. Governance & community

AGPL-3.0-only (app, core) / MIT (`plugin-sdk`, fixtures, starters) per D12; DCO sign-off enforced by CI; `CODE_OF_CONDUCT.md` (Contributor Covenant), `CONTRIBUTING.md` with agent-and-human-facing setup that is deterministic (`pnpm i && pnpm dev` must just work; devcontainer provided). Semver: app follows semantic *product* versioning (1.0 at M6); `plugin-sdk` independently semver'd. Changes to public plugin API or file formats require a short RFC (issue template) + ADR. GitHub Discussions for community; plugin/theme registries as separate repos with the automated pipeline (§3.13). Trademark policy file reserving the name/logo while code stays libre. A `MAINTAINERS.md` bus-factor plan: ≥ 2 humans with release keys from M1.

## 8. Risk register

| Risk | L×I | Mitigation |
|---|---|---|
| Webview inconsistency (esp. WebKitGTK perf/rendering) | M×H | §5.11 program; Linux sign-off gates on E22/E23; Electron escape hatch kept honest by IPC-only frontend (D1). |
| Live Preview complexity spirals | H×H | E10 built per-syntax-family behind flags; fixture-driven; ship Source+Reading first; budget guarded by bench. |
| AI-generated code quality drift | H×H | §6.3 DoD, per-AC tests, coverage gates, small tickets, human review required on `crates/loam-core` and `plugin-sdk`, weekly refactor budget. |
| Plugin ecosystem trust incident | M×H | Restricted-mode default, registry checks + review, permissions UX, rapid-pull process + signed index (§3.13/§5.7). |
| Name/trademark conflict | M×M | §9 checklist is a launch blocker; name is a variable until cleared. |
| Obsidian ships something that resets parity (e.g. Bases growth) | H×M | Wedge is trust/openness, not feature count (§1.2); S1 spike watches this; compat-first posture limits switching cost either way. |
| Scope creep vs. the parity dream | H×M | §3.15 exclusions; `decision-needed` protocol; milestone exit criteria are the only definition of progress. |
| Apple policy vs. downloadable plugins on iOS | L×M | S5 spike before E24; fallback = curated bundled plugins on mobile (Obsidian precedent suggests low risk). |
| Maintainer burnout / bus factor | M×H | §7 governance, 2-key rule, ruthless automation, community handoff docs from day one. |
| Upstream churn (CM6/comrak/Tauri majors) | L×M | Renovate grouped updates, pinned majors, ADR-gated upgrades, thin wrappers around volatile APIs. |

## 9. Name

### 9.1 Decision

**Loam** — the dark, fertile soil where things take root. Four letters, one syllable, phonetic to spell, trivially pronounceable in most languages, and it tells the product's story: Obsidian is sealed volcanic glass; loam is open ground that grows things. It lands squarely in the PKM community's own "digital garden" vocabulary, pairs with warm, confident branding, and gives us the best domain hack in the category: **loam.md** (.md — Markdown) as the canonical home, with `getloam.com`/`loam.app` as redirect candidates.

### 9.2 Vetting performed (July 2026, non-exhaustive — see checklist)

No note-taking/PKM product named "Loam" found. Adjacent findings, judged acceptable but listed for the trademark search: **LOAME** (loame.app, small all-in-one productivity app — closest string in an adjacent category; distinct mark, but verify), Loam Bio (agtech), design agencies, npm package `loam` (a GDAL/WASM lib → we publish under the `@loam-app` npm scope and `loam-core` crate names regardless). Rejected candidates and why: **Geode** (a transcription-notes app *and* the Geometry Dash mod loader own the space — perfect metaphor, dead on arrival), **Basalt** (existing open-source TUI for Obsidian vaults — same niche), **Slate/Outline/Reflect/Memex/Tangent** (all existing notes products), **Cairn** (runner-up: beautiful trail-marker metaphor, but cairn.info is a major academic knowledge platform, the dog breed owns SEO, and the spelling wobbles), **Pumice** (second runner-up: volcanic-but-porous is a cheeky anti-Obsidian pun; weaker brand energy).

### 9.3 Runner-up order if Loam fails clearance

1. Cairn · 2. Pumice · 3. Tuff. Re-run §9.5 for whichever survives.

### 9.4 Rename protocol

Identifiers use the `loam` string freely (`loam-core`, `--loam-*`, `.loam/`, `loam://`). A scripted rename (`scripts/rename.sh <NewName>`) is an M0 deliverable: global case-aware substitution + token prefix + URI scheme + bundle IDs, verified by CI. Cheap insurance; zero ongoing tax.

### 9.5 Clearance checklist (human task, launch blocker, `human-needed`)

Trademark knock-out search in software classes 9 & 42: IP Australia, USPTO, EUIPO, UKIPO (+ professional search before 1.0); register or control: loam.md, getloam.com, loam.app if available; GitHub org (`loam-app` or `getloam`); npm scope `@loam-app`; crates.io `loam-core`/`loam-*`; social handles; check App Store / Play Store name collisions. Document results in `/docs/adr/adr-000-name.md`.

## 10. Glossary

**Vault** — a folder of Markdown files opened by Loam. **Note** — a Markdown file. **Wikilink** — `[[Target]]` internal link. **Embed/transclusion** — `![[Target]]` rendering another note's content in place. **Backlink** — an inbound link to the current note. **Live Preview** — editing mode that renders Markdown in place while remaining source-editable. **Omnibar** — the ⌘K surface unifying navigation and commands. **Properties** — typed YAML frontmatter fields. **Core** — `crates/loam-core`, the Rust engine. **Registry** — the community plugin/theme index. **SLO** — a §5.9 latency/size budget treated as a requirement. **JSON Canvas** — the open `.canvas` spatial-file format Loam implements.

---

*End of specification. Generate tickets per §6.5. Build something people will trust for fifty years.*
