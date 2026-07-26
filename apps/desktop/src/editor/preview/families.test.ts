/** LOA-102: headings and inline emphasis rendered in place. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../sessions";
import { loamEditorTheme } from "../theme";
import { engineOf } from "./engine";
import { CORE_FAMILIES, headingFamily, inlineFamily } from "./families";

/** The E03 conformance corpus is the shared contract for both parsers. */
const FIXTURE_DIR = join(import.meta.dirname, "../../../../../fixtures/markdown/core");
function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.md`), "utf8");
}

let counter = 0;
function editor(doc: string, livePreview = true) {
  const registry = new SessionRegistry();
  counter += 1;
  const session = registry.open(`inline-${counter}.md`, doc, null, { livePreview });
  const view = new EditorView({ state: session.state });
  // Park the cursor past the end of the fixture so nothing is revealed.
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
  return view;
}

interface Drawn {
  replaced: Array<{ from: number; to: number }>;
  lineClasses: Map<number, string>;
  markClasses: Array<{ from: number; to: number; class: string }>;
}

function drawn(view: EditorView): Drawn {
  const engine = engineOf(view);
  if (!engine) throw new Error("engine not mounted");
  const result: Drawn = { replaced: [], lineClasses: new Map(), markClasses: [] };
  engine.decorations.between(0, view.state.doc.length, (from, to, value) => {
    const spec = value.spec as { class?: string };
    if (value.point && from === to && spec.class) {
      result.lineClasses.set(view.state.doc.lineAt(from).number, spec.class);
    } else if (spec.class) {
      result.markClasses.push({ from, to, class: spec.class });
    } else {
      result.replaced.push({ from, to });
    }
  });
  return result;
}

/** What a reader sees: the source minus every replaced range. */
function rendered(view: EditorView): string {
  const { replaced } = drawn(view);
  let out = "";
  let at = 0;
  for (const cut of replaced) {
    out += view.state.sliceDoc(at, cut.from);
    at = cut.to;
  }
  return out + view.state.sliceDoc(at);
}

/** AC1: every heading level carries its §4.2 role. */
describe("heading typography", () => {
  const doc = ["# One", "## Two", "### Three", "#### Four", "##### Five", "###### Six"].join("\n");

  it("assigns H1–H6 their own line class", () => {
    const view = editor(doc);
    const classes = [...drawn(view).lineClasses.entries()].sort((a, b) => a[0] - b[0]);
    expect(classes.map(([, name]) => name)).toEqual([
      "cm-loam-h1",
      "cm-loam-h2",
      "cm-loam-h3",
      "cm-loam-h4",
      "cm-loam-h5",
      "cm-loam-h6",
    ]);
  });

  it("the theme maps each role to the documented §4.2 tokens", () => {
    // The theme spec is the source of these values; §4.2 says H1 1.55em/650,
    // H2 1.30em/650, H3 1.15em/600, H4–H6 1.0em/600 with H5/H6 stepping down
    // in color.
    const rules = JSON.stringify(loamEditorTheme);
    for (const [selector, size, weight] of [
      ["cm-loam-h1", "h1", "h1"],
      ["cm-loam-h2", "h2", "h2"],
      ["cm-loam-h3", "h3", "h3"],
      ["cm-loam-h4", "h4", "h4"],
      ["cm-loam-h5", "h4", "h4"],
      ["cm-loam-h6", "h4", "h4"],
    ] as const) {
      expect(rules).toContain(selector);
      expect(rules).toContain(`--loam-type-${size}-size`);
      expect(rules).toContain(`--loam-type-${weight}-weight`);
    }
    expect(rules).toContain("--loam-text-secondary");
    expect(rules).toContain("--loam-text-tertiary");
  });

  it("hides the `#` marks and the space after them", () => {
    const view = editor("## Heading\n\nbody\n");
    expect(rendered(view).split("\n")[0]).toBe("Heading");
  });
});

/** AC2: markers hide only while the cursor is outside their line. */
describe("marker reveal", () => {
  const doc = "Plain **bold** and _italic_ and ~~struck~~ and `code` here.\n\nSecond line.\n";

  it("hides every inline marker when the cursor is elsewhere", () => {
    const view = editor(doc);
    expect(rendered(view)).toContain("Plain bold and italic and struck and code here.");
  });

  it("restores the markers on the cursor's line", () => {
    const view = editor(doc);
    view.dispatch({ selection: EditorSelection.cursor(3) });
    const output = rendered(view);
    expect(output).toContain("**bold**");
    expect(output).toContain("_italic_");
    expect(output).toContain("~~struck~~");
    expect(output).toContain("`code`");
    // The document itself never changed.
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("styles inline code as its own span", () => {
    const view = editor(doc);
    const code = drawn(view).markClasses.filter((mark) => mark.class === "cm-loam-code");
    expect(code).toHaveLength(1);
    expect(view.state.sliceDoc(code[0]?.from, code[0]?.to)).toBe("`code`");
  });
});

/** AC3: nested and overlapping emphasis stays editable and intact. */
describe("nested emphasis", () => {
  it("renders the E03 headings-and-inlines fixture without losing text", () => {
    const source = fixture("headings-and-inlines");
    const view = editor(source);
    const output = rendered(view);
    // Nested `*emphasis with **strong** inside*` keeps every word.
    expect(output).toContain("Nested emphasis with strong inside");
    expect(output).toContain("Body with inline code, bold, italic, and both.");
    // Literal `#` inside a heading is text, not a marker.
    expect(output).toContain("Deep > heading with # literal hash");
    expect(view.state.doc.toString()).toBe(source);
  });

  it("survives an edit inside nested emphasis", () => {
    const doc = "A *outer **inner** rest* tail\n";
    const view = editor(doc);
    const at = doc.indexOf("inner") + 5;
    view.dispatch({ selection: EditorSelection.cursor(at) });
    view.dispatch({ changes: { from: at, insert: "MOST" } });
    expect(view.state.doc.toString()).toBe("A *outer **innerMOST** rest* tail\n");
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    expect(rendered(view)).toContain("outer innerMOST rest");
  });
});

/** AC4: escaped markers are literal characters, never emphasis. */
describe("escapes", () => {
  it("keeps escaped markers literal and drops only the backslash", () => {
    const view = editor("Literal \\*not emphasis\\* and \\_not italic\\_ here.\n");
    const output = rendered(view);
    expect(output).toContain("*not emphasis*");
    expect(output).toContain("_not italic_");
    // Nothing was treated as an emphasis span, so no text was hidden.
    expect(output).not.toContain("not emphasis and");
  });

  it("renders the E03 escapes fixture with its source intact", () => {
    const source = fixture("escapes");
    const view = editor(source);
    expect(view.state.doc.toString()).toBe(source);
  });
});

/** AC5: Live Preview and Source hold the same bytes after the same edits. */
describe("source equivalence", () => {
  it("the same edits produce the same document in both modes", () => {
    const source = "# Title\n\nSome **bold** text.\n";
    const preview = editor(source, true);
    const plain = editor(source, false);

    for (const view of [preview, plain]) {
      const line = view.state.doc.line(3);
      view.dispatch({ selection: EditorSelection.cursor(line.to) });
      view.dispatch({ changes: { from: line.to, insert: " More _words_." } });
    }
    expect(preview.state.doc.toString()).toBe(plain.state.doc.toString());
    expect(plain.state.doc.toString()).toBe("# Title\n\nSome **bold** text. More _words_.\n");
  });

  it("Source mode draws nothing at all", () => {
    const view = editor("# Title\n\n**bold**\n", false);
    const decorations = drawn(view);
    expect(decorations.replaced).toEqual([]);
    expect(decorations.lineClasses.size).toBe(0);
    expect(rendered(view)).toBe("# Title\n\n**bold**\n");
  });
});

/** The families are independent flags on the LOA-95 engine. */
describe("registration", () => {
  it("registers headings and inline as separate families", () => {
    // Each syntax family is its own flag on the engine (LOA-95 AC1).
    expect(CORE_FAMILIES.map((family) => family.name)).toEqual([
      "headings",
      "inline",
      "lists",
      "tasks",
      "quotes",
    ]);
    expect(headingFamily.nodes).toContain("ATXHeading1");
    expect(inlineFamily.nodes).toContain("StrikethroughMark");
  });
});
