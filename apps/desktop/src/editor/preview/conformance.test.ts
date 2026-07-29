/**
 * LOA-119 AC1: the M1 Live Preview conformance matrix.
 *
 * Every fixture in the E03 corpus is opened in Live Preview and the result is
 * compared against a committed snapshot of what got decorated. The corpus is
 * the contract between loam-core's structure and the Lezer decorations, so a
 * change in either shows up here as a diff rather than as a surprise in the
 * editor.
 *
 * Regenerate with `LOAM_UPDATE_FIXTURES=1 pnpm --filter @loam-app/desktop test`
 * and review the diff — the same convention the Rust fixtures use.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../sessions";
import { engineOf } from "./engine";
import { frontmatterField } from "./frontmatter";

const CORPUS = join(import.meta.dirname, "../../../../../fixtures/markdown");
const SNAPSHOT = join(CORPUS, "live-preview.expected.json");
const UPDATE = process.env.LOAM_UPDATE_FIXTURES === "1";

function fixtures(): Array<{ id: string; source: string }> {
  const found: Array<{ id: string; source: string }> = [];
  for (const group of readdirSync(CORPUS, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const file of readdirSync(join(CORPUS, group.name)).sort()) {
      if (!file.endsWith(".md")) continue;
      found.push({
        id: `${group.name}/${file.replace(/\.md$/, "")}`,
        source: readFileSync(join(CORPUS, group.name, file), "utf8"),
      });
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

interface Decorated {
  /** Text a reader sees: the source minus every replaced range. */
  rendered: string;
  /** Line-level classes, as `line:class` pairs. */
  lines: string[];
  /** Inline classes, as `class:text` pairs. */
  marks: string[];
  /** Widgets, by the DOM element they produce. */
  widgets: string[];
  /** Ranges hidden from the reader, as `syntaxNode:text`. */
  hidden: string[];
}

let counter = 0;
function decorate(source: string): Decorated {
  const registry = new SessionRegistry();
  counter += 1;
  const session = registry.open(`conformance-${counter}.md`, source, null);
  const view = new EditorView({ state: session.state });
  // Park the cursor past the end: nothing is revealed for editing.
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });

  const engine = engineOf(view);
  if (!engine) throw new Error("engine not mounted");
  const result: Decorated = { rendered: "", lines: [], marks: [], widgets: [], hidden: [] };
  const cuts: Array<[number, number]> = [];

  const collect = (from: number, to: number, value: { spec: unknown; point: boolean }) => {
    const spec = value.spec as {
      class?: string;
      widget?: { toDOM(view: EditorView): HTMLElement };
    };
    if (spec.widget) {
      const dom = spec.widget.toDOM(view);
      result.widgets.push(dom.tagName.toLowerCase() + (dom.className ? `.${dom.className}` : ""));
      if (from !== to) cuts.push([from, to]);
      return;
    }
    if (value.point && from === to && spec.class) {
      result.lines.push(`${view.state.doc.lineAt(from).number}:${spec.class}`);
      return;
    }
    if (spec.class) {
      result.marks.push(`${spec.class}:${view.state.sliceDoc(from, to)}`);
      return;
    }
    // Naming the node the range came from turns "something is hidden" into
    // "this marker is hidden", which is what the invariant below checks.
    const node = syntaxTree(view.state).resolveInner(from, 1);
    result.hidden.push(`${node.name}:${view.state.sliceDoc(from, to)}`);
    cuts.push([from, to]);
  };

  engine.decorations.between(0, view.state.doc.length, collect);
  view.state.field(frontmatterField, false)?.between(0, view.state.doc.length, collect);

  cuts.sort((a, b) => a[0] - b[0]);
  let at = 0;
  for (const [from, to] of cuts) {
    if (from < at) continue;
    result.rendered += view.state.sliceDoc(at, from);
    at = to;
  }
  result.rendered += view.state.sliceDoc(at);
  view.destroy();
  return result;
}

/** Syntax nodes Live Preview is allowed to take off the screen. */
const HIDEABLE = [
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "CodeInfo",
  "QuoteMark",
  "Escape",
  "TaskMarker",
  "Frontmatter",
];

const corpus = fixtures();
const measured = Object.fromEntries(corpus.map(({ id, source }) => [id, decorate(source)]));

if (UPDATE) {
  writeFileSync(SNAPSHOT, `${JSON.stringify(measured, null, 2)}\n`);
}

const expected = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, Decorated>;

describe("Live Preview conformance matrix", () => {
  it("covers the whole corpus", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(28);
    expect(Object.keys(expected).sort()).toEqual(corpus.map(({ id }) => id));
  });

  for (const { id, source } of corpus) {
    describe(id, () => {
      it("matches the expected decorated structure", () => {
        expect(measured[id]).toEqual(expected[id]);
      });

      it("renders without touching the source", () => {
        // Decoration is a drawing decision; the bytes are the contract.
        const registry = new SessionRegistry();
        counter += 1;
        const session = registry.open(`untouched-${counter}.md`, source, null);
        const view = new EditorView({ state: session.state });
        view.dispatch({ selection: EditorSelection.cursor(0) });
        view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
        expect(view.state.doc.toString()).toBe(source);
        view.destroy();
      });

      it("only hides syntax, never prose", () => {
        // Live Preview may hide a marker, a fence and its info string (the
        // chip carries that), or an escape backslash. Anything else means a
        // family swallowed content a reader needed.
        for (const hidden of measured[id]?.hidden ?? []) {
          const node = hidden.slice(0, hidden.indexOf(":"));
          expect(HIDEABLE).toContain(node);
        }
      });
    });
  }
});
