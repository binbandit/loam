/** LOA-95: the flagged Live Preview decoration engine. */

import { EditorSelection } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../sessions";
import {
  enabledFamilies,
  engineOf,
  revealedSpans,
  type SyntaxFamily,
  setLivePreviewFamilies,
} from "./engine";

const hidden = Decoration.replace({});

/** Hides `**`/`_` marks unless the cursor is on their line. */
const emphasis: SyntaxFamily = {
  name: "emphasis",
  nodes: ["EmphasisMark", "StrongEmphasisMark"],
  decorate(node, context) {
    if (context.revealed(node.from, node.to)) return;
    context.add(node.from, node.to, hidden);
  },
};

/** Hides the `#` of a heading, same rule. */
const heading: SyntaxFamily = {
  name: "heading",
  nodes: ["HeaderMark"],
  decorate(node, context) {
    if (context.revealed(node.from, node.to)) return;
    context.add(node.from, node.to, hidden);
  },
};

const exploding: SyntaxFamily = {
  name: "exploding",
  nodes: ["EmphasisMark"],
  decorate() {
    throw new Error("decorator blew up");
  },
};

const DOC = [
  "# Heading one",
  "",
  "Body with **bold** and _italic_ text.",
  "",
  "## Heading two",
].join("\n");

let counter = 0;
function editor(doc = DOC, families: readonly SyntaxFamily[] = [emphasis, heading]) {
  const registry = new SessionRegistry();
  counter += 1;
  // Start with no families so these tests drive the engine with their own
  // fixtures rather than the shipped LOA-102 set.
  const session = registry.open(`preview-${counter}.md`, doc, null, { livePreview: false });
  const view = new EditorView({ state: session.state });
  // Park the cursor at the end so line 1 is not "revealed" by default.
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
  setLivePreviewFamilies(view, families);
  return view;
}

function decorationCount(view: EditorView): number {
  const engine = engineOf(view);
  if (!engine) throw new Error("engine not mounted");
  let count = 0;
  engine.decorations.between(0, view.state.doc.length, () => {
    count += 1;
  });
  return count;
}

/** What the user would see: the document minus everything replaced. */
function rendered(view: EditorView): string {
  const engine = engineOf(view);
  if (!engine) throw new Error("engine not mounted");
  const cuts: Array<[number, number]> = [];
  engine.decorations.between(0, view.state.doc.length, (from, to) => {
    cuts.push([from, to]);
  });
  let out = "";
  let at = 0;
  for (const [from, to] of cuts) {
    out += view.state.sliceDoc(at, from);
    at = to;
  }
  return out + view.state.sliceDoc(at);
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** AC1: flags flip in place — the state (and its history) survives. */
describe("family flags", () => {
  it("toggles families without recreating the editor state", () => {
    const view = editor();
    expect(enabledFamilies(view.state).map((family) => family.name)).toEqual([
      "emphasis",
      "heading",
    ]);
    const before = decorationCount(view);
    expect(before).toBeGreaterThan(0);

    setLivePreviewFamilies(view, [heading]);
    expect(enabledFamilies(view.state).map((family) => family.name)).toEqual(["heading"]);
    expect(decorationCount(view)).toBeLessThan(before);
    // Same document, same session: nothing was rebuilt from scratch.
    expect(view.state.doc.toString()).toBe(DOC);

    setLivePreviewFamilies(view, [emphasis, heading]);
    expect(decorationCount(view)).toBe(before);
  });
});

/** AC2: an ordinary edit re-decorates the edited lines, nothing else. */
describe("incremental updates", () => {
  it("rebuilds only the changed line", () => {
    const view = editor();
    const line = view.state.doc.line(3);
    view.dispatch({ selection: EditorSelection.cursor(line.to) });
    view.dispatch({ changes: { from: line.to, insert: "!" } });

    const engine = engineOf(view);
    if (!engine) throw new Error("engine not mounted");
    const built = engine.lastBuilt;
    expect(built.length).toBeGreaterThan(0);
    const updated = view.state.doc.line(3);
    for (const span of built) {
      expect(span.from).toBeGreaterThanOrEqual(updated.from);
      expect(span.to).toBeLessThanOrEqual(updated.to);
    }
    // The heading on line 1 was never revisited but is still decorated.
    expect(rendered(view)).toContain("Heading one");
    expect(rendered(view)).not.toContain("# Heading one");
  });

  it("re-decorates the lines the cursor leaves and enters", () => {
    const view = editor();
    const third = view.state.doc.line(3);
    view.dispatch({ selection: EditorSelection.cursor(third.from + 2) });
    const engine = engineOf(view);
    if (!engine) throw new Error("engine not mounted");
    // Only the previously revealed line and the new one are touched.
    for (const span of engine.lastBuilt) {
      expect(span.to - span.from).toBeLessThanOrEqual(third.to - third.from + 1);
    }
  });

  it("typing at the end does not re-decorate the whole viewport", () => {
    const view = editor();
    const last = view.state.doc.line(view.state.doc.lines);
    view.dispatch({ selection: EditorSelection.cursor(last.to) });
    view.dispatch({ changes: { from: last.to, insert: "x" } });
    const built = engineOf(view)?.lastBuilt ?? [];
    // A longer document is not "newly visible text": only the typed line is
    // rebuilt, even though the viewport's end moved with it.
    const total = built.reduce((sum, span) => sum + (span.to - span.from), 0);
    expect(total).toBeLessThan(view.state.doc.length / 2);
  });

  it("a selection-less, edit-less update rebuilds nothing", () => {
    const view = editor();
    view.dispatch({});
    expect(engineOf(view)?.lastBuilt).toEqual([]);
  });
});

/** AC3: the cursor's line shows its raw marks, and the doc never changes. */
describe("cursor reveal", () => {
  it("reveals marks on the cursor's line only", () => {
    const view = editor();
    expect(rendered(view)).toContain("Body with bold and italic text.");

    const body = view.state.doc.line(3);
    view.dispatch({ selection: EditorSelection.cursor(body.from + 5) });
    const withCursor = rendered(view);
    expect(withCursor).toContain("**bold**");
    expect(withCursor).toContain("_italic_");
    // Other lines stay rendered.
    expect(withCursor).not.toContain("# Heading one");
    // Revealing is a drawing decision: the source is untouched.
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("reveals every line a multi-line selection covers", () => {
    const view = editor();
    const spans = revealedSpans(
      view.state.update({
        selection: EditorSelection.range(0, view.state.doc.line(3).to),
      }).state,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]?.from).toBe(0);
    expect(spans[0]?.to).toBe(view.state.doc.line(3).to);
  });
});

/** AC4: no families enabled is byte-for-byte Source mode. */
describe("all flags off", () => {
  it("draws nothing and renders the exact source", () => {
    const view = editor(DOC, []);
    expect(enabledFamilies(view.state)).toEqual([]);
    expect(decorationCount(view)).toBe(0);
    expect(rendered(view)).toBe(DOC);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("turning every family off restores the source", () => {
    const view = editor();
    expect(rendered(view)).not.toBe(DOC);
    setLivePreviewFamilies(view, []);
    expect(decorationCount(view)).toBe(0);
    expect(rendered(view)).toBe(DOC);
  });
});

/** AC5: one bad family is retired; the rest — and the source — survive. */
describe("failure isolation", () => {
  it("disables the throwing family and keeps the others", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = editor(DOC, [exploding, heading]);

    const engine = engineOf(view);
    if (!engine) throw new Error("engine not mounted");
    expect(engine.failures).toContain("exploding");
    expect(logged).toHaveBeenCalled();

    // The disable effect lands on the next microtask.
    await Promise.resolve();
    expect(enabledFamilies(view.state).map((family) => family.name)).toEqual(["heading"]);

    // Headings still render, emphasis marks stay raw, source is intact.
    const output = rendered(view);
    expect(output).toContain("**bold**");
    expect(output).not.toContain("# Heading one");
    expect(view.state.doc.toString()).toBe(DOC);

    // And the editor still accepts edits.
    view.dispatch({ changes: { from: view.state.doc.length, insert: " more" } });
    expect(view.state.doc.toString()).toBe(`${DOC} more`);
  });

  it("logs once per family, not once per node", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = editor(DOC, [exploding]);
    await Promise.resolve();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
