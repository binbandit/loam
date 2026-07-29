/**
 * LOA-119 AC4: rapid edit/undo returns the exact source.
 *
 * Live Preview maps decorations through every change and rebuilds dirty
 * spans; a bug there could survive a single edit and only show up after a
 * burst. The sequence is pseudo-random but seeded, so a failure reproduces
 * exactly from the seed printed in the assertion.
 */

import { redo, undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../sessions";

const SOURCE = [
  "---",
  "title: Fuzz",
  "tags: [a, b]",
  "---",
  "",
  "# Heading",
  "",
  "Body with **bold**, _italic_, ~~struck~~, and `code`.",
  "",
  "- [ ] task one",
  "- [x] task two",
  "  - nested item",
  "",
  "> quoted line",
  "",
  "```js",
  "const answer = 42;",
  "```",
  "",
  "Trailing paragraph.",
  "",
].join("\n");

/** Deterministic PRNG (mulberry32) — a failing seed replays exactly. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SNIPPETS = ["x", "**", "`", "- [ ] ", "# ", "> ", "\n", "~~", "[[", "…", "漢"];

let counter = 0;
function editor(doc: string) {
  const registry = new SessionRegistry();
  counter += 1;
  const session = registry.open(`fuzz-${counter}.md`, doc, null);
  return new EditorView({ state: session.state });
}

describe("edit/undo bursts", () => {
  it.each([1, 7, 42, 1337, 90210])("seed %i: undo restores the exact source", (seed) => {
    const next = random(seed);
    const view = editor(SOURCE);

    for (let step = 0; step < 40; step += 1) {
      const at = Math.floor(next() * view.state.doc.length);
      const roll = next();
      if (roll < 0.55) {
        const insert = SNIPPETS[Math.floor(next() * SNIPPETS.length)] as string;
        view.dispatch({
          changes: { from: at, insert },
          selection: EditorSelection.cursor(at + insert.length),
        });
      } else if (roll < 0.8) {
        const to = Math.min(view.state.doc.length, at + 1 + Math.floor(next() * 6));
        view.dispatch({ changes: { from: at, to }, selection: EditorSelection.cursor(at) });
      } else {
        // Moving the cursor flips lines between raw and rendered mid-burst.
        view.dispatch({ selection: EditorSelection.cursor(at) });
      }
    }

    // Undo everything the burst did.
    for (let step = 0; step < 60; step += 1) undo(view);
    expect(view.state.doc.toString(), `seed ${seed}`).toBe(SOURCE);
  });

  it("redo replays a burst exactly", () => {
    const view = editor(SOURCE);
    const line = view.state.doc.line(8);
    view.dispatch({ selection: EditorSelection.cursor(line.to) });
    view.dispatch({ changes: { from: line.to, insert: " and more **text**" } });
    const edited = view.state.doc.toString();

    undo(view);
    expect(view.state.doc.toString()).toBe(SOURCE);
    redo(view);
    expect(view.state.doc.toString()).toBe(edited);
  });

  it("interleaved edit and undo never drifts", () => {
    const next = random(2026);
    const view = editor(SOURCE);
    for (let step = 0; step < 30; step += 1) {
      const at = Math.floor(next() * view.state.doc.length);
      view.dispatch({ changes: { from: at, insert: "z" } });
      undo(view);
      expect(view.state.doc.toString()).toBe(SOURCE);
    }
  });
});
