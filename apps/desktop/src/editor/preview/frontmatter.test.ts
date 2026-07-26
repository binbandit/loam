/** LOA-114: frontmatter as a read-only property table. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../sessions";
import { frontmatterField, MALFORMED_NOTICE, parseFrontmatter } from "./frontmatter";

const FIXTURES = join(import.meta.dirname, "../../../../../fixtures/markdown");
function fixture(group: string, name: string): string {
  return readFileSync(join(FIXTURES, group, `${name}.md`), "utf8");
}

let counter = 0;
function editor(doc: string, livePreview = true) {
  const registry = new SessionRegistry();
  counter += 1;
  const session = registry.open(`fm-${counter}.md`, doc, null, { livePreview });
  const view = new EditorView({ state: session.state });
  // Cursor at the end: the frontmatter block is not being edited.
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
  return view;
}

/** Block decorations come from the field, not the engine's view plugin. */
function widgetDom(view: EditorView): HTMLElement | null {
  // Absent in Source mode: the family — and its field — are not installed.
  const field = view.state.field(frontmatterField, false);
  if (!field) return null;
  let dom: HTMLElement | null = null;
  field.between(0, view.state.doc.length, (_from, _to, value) => {
    const spec = value.spec as { widget?: WidgetType };
    if (spec.widget && !dom) dom = spec.widget.toDOM(view) as HTMLElement;
  });
  return dom;
}

function rows(view: EditorView): Array<[string, string]> {
  const dom = widgetDom(view);
  if (!dom) return [];
  return [...dom.querySelectorAll("tr")].map((row) => [
    row.querySelector("th")?.textContent ?? "",
    row.querySelector("td")?.textContent ?? "",
  ]);
}

/** The parser only exists because `---` must be a real node to route on. */
describe("block parser", () => {
  it("parses a closed block as a Frontmatter node", () => {
    const view = editor(fixture("frontmatter", "valid"));
    const names: string[] = [];
    syntaxTree(view.state).iterate({
      enter: (node) => {
        names.push(node.name);
      },
    });
    expect(names).toContain("Frontmatter");
  });

  it("leaves an unterminated delimiter alone", () => {
    // loam-core reports rawFrontmatter: null here — there is no block.
    const source = fixture("malformed", "unterminated-frontmatter");
    const view = editor(source);
    const names: string[] = [];
    syntaxTree(view.state).iterate({
      enter: (node) => {
        names.push(node.name);
      },
    });
    expect(names).not.toContain("Frontmatter");
    expect(view.state.doc.toString()).toBe(source);
  });

  it("only the first line can open frontmatter", () => {
    const view = editor("# Title\n\n---\nnot: frontmatter\n---\n");
    const names: string[] = [];
    syntaxTree(view.state).iterate({
      enter: (node) => {
        names.push(node.name);
      },
    });
    expect(names).not.toContain("Frontmatter");
  });
});

/** AC1: every key/value renders, and the file is untouched. */
describe("valid frontmatter", () => {
  it("renders the E03 valid fixture as a property table", () => {
    const source = fixture("frontmatter", "valid");
    const view = editor(source);
    expect(rows(view)).toEqual([
      ["title", "Valid Frontmatter"],
      ["tags", "alphabeta/nested"],
      ["aliases", "VFValid FM"],
    ]);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("renders every key of the typed fixture in order", () => {
    const source = fixture("frontmatter", "typed");
    const view = editor(source);
    const keys = rows(view).map(([key]) => key);
    expect(keys).toEqual([
      "title",
      "rating",
      "weight",
      "draft",
      "published",
      "due",
      "updated",
      "tags",
      "aliases",
      "empty-one",
      "notes",
    ]);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("keeps scalar values verbatim, quotes stripped", () => {
    const parsed = parseFrontmatter('title: Plain\nrating: 4\nquoted: "keep me"\n');
    expect(parsed?.properties).toEqual([
      { key: "title", value: "Plain" },
      { key: "rating", value: "4" },
      { key: "quoted", value: "keep me" },
    ]);
  });
});

/** AC4: tags and aliases keep their order and every value. */
describe("lists", () => {
  it("reads block and flow lists identically", () => {
    const block = parseFrontmatter("tags:\n  - one\n  - two/three\n");
    const flow = parseFrontmatter('tags: [one, "two/three"]\n');
    expect(block?.properties[0]?.value).toEqual(["one", "two/three"]);
    expect(flow?.properties[0]?.value).toEqual(["one", "two/three"]);
  });

  it("renders tags and aliases as chips in source order", () => {
    const view = editor("---\ntags: [b, a, c]\naliases:\n  - second\n  - first\n---\n\nBody\n");
    const dom = widgetDom(view);
    const chips = [...(dom?.querySelectorAll(".cm-loam-prop-chip") ?? [])].map(
      (chip) => chip.textContent,
    );
    expect(chips).toEqual(["b", "a", "c", "second", "first"]);
  });

  it("an empty value renders as a placeholder, not a lost key", () => {
    const view = editor("---\nempty-one:\ntitle: x\n---\n\nBody\n");
    expect(rows(view)).toEqual([
      ["empty-one", "—"],
      ["title", "x"],
    ]);
  });
});

/** AC3: unreadable YAML gets the banner and keeps its raw source. */
describe("malformed frontmatter", () => {
  it("refuses the bad-yaml fixture rather than half-parsing it", () => {
    expect(
      parseFrontmatter("title: [unclosed bracket\ntags: still: not: valid: yaml\n"),
    ).toBeNull();
  });

  it("shows the exact banner and leaves the YAML visible", () => {
    const source = fixture("malformed", "bad-yaml-frontmatter");
    const view = editor(source);
    const dom = widgetDom(view);
    expect(dom?.textContent).toBe(MALFORMED_NOTICE);
    expect(dom?.getAttribute("role")).toBe("status");

    // Nothing is replaced: the raw YAML is still on screen and in the file.
    let replaced = 0;
    view.state.field(frontmatterField, false)?.between(0, view.state.doc.length, (from, to) => {
      if (from !== to) replaced += 1;
    });
    expect(replaced).toBe(0);
    expect(view.state.doc.toString()).toBe(source);
  });
});

/** AC2/AC5: Source shows YAML; the table is a real table. */
describe("modes and semantics", () => {
  it("Source mode draws nothing at all", () => {
    const source = fixture("frontmatter", "valid");
    const view = editor(source, false);
    expect(widgetDom(view)).toBeNull();
    expect(view.state.doc.toString()).toBe(source);
  });

  it("putting the cursor in the block reveals the raw YAML", () => {
    const view = editor(fixture("frontmatter", "valid"));
    expect(widgetDom(view)).not.toBeNull();
    view.dispatch({ selection: EditorSelection.cursor(6) });
    expect(widgetDom(view)).toBeNull();
  });

  it("uses row headers and a caption for screen readers", () => {
    const dom = widgetDom(editor(fixture("frontmatter", "valid")));
    expect(dom?.tagName).toBe("TABLE");
    expect(dom?.querySelector("caption")?.textContent).toBe("Note properties");
    const headers = [...(dom?.querySelectorAll("th") ?? [])];
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) expect(header.getAttribute("scope")).toBe("row");
  });
});
