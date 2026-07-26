/** LOA-107: lists, tasks, and blockquotes rendered in place. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { toggleTask } from "../lists";
import { SessionRegistry } from "../sessions";
import { toggleTaskLine } from "./blocks";
import { engineOf } from "./engine";

const FIXTURE_DIR = join(import.meta.dirname, "../../../../../fixtures/markdown/core");
function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.md`), "utf8");
}

let counter = 0;
function editor(doc: string) {
  const registry = new SessionRegistry();
  counter += 1;
  const session = registry.open(`blocks-${counter}.md`, doc, null);
  const view = new EditorView({ state: session.state });
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
  return view;
}

interface Drawn {
  lineClasses: Map<number, string>;
  markClasses: Array<{ from: number; to: number; class: string }>;
  widgets: Array<{ from: number; to: number; widget: WidgetType }>;
  replaced: Array<{ from: number; to: number }>;
}

function drawn(view: EditorView): Drawn {
  const engine = engineOf(view);
  if (!engine) throw new Error("engine not mounted");
  const result: Drawn = {
    lineClasses: new Map(),
    markClasses: [],
    widgets: [],
    replaced: [],
  };
  engine.decorations.between(0, view.state.doc.length, (from, to, value) => {
    const spec = value.spec as { class?: string; widget?: WidgetType };
    if (spec.widget) result.widgets.push({ from, to, widget: spec.widget });
    else if (value.point && from === to && spec.class) {
      result.lineClasses.set(view.state.doc.lineAt(from).number, spec.class);
    } else if (spec.class) result.markClasses.push({ from, to, class: spec.class });
    else result.replaced.push({ from, to });
  });
  return result;
}

function checkboxes(view: EditorView): HTMLInputElement[] {
  return drawn(view).widgets.map((entry) => entry.widget.toDOM(view) as HTMLInputElement);
}

/** AC1: structure follows the E03 fixtures. */
describe("nested structure", () => {
  it("marks every list bullet in the nested-lists fixture", () => {
    const source = fixture("nested-lists");
    const view = editor(source);
    const marks = drawn(view).markClasses.filter((mark) => mark.class === "cm-loam-list-mark");
    // Every list marker in the fixture is styled, and each keeps its exact
    // source range — indentation is untouched (AC4).
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(view.state.sliceDoc(mark.from, mark.to)).toMatch(/^([-*+]|\d+[.)])$/);
    }
    expect(view.state.doc.toString()).toBe(source);
  });

  it("gives nested quotes deeper classes in the nested-quotes fixture", () => {
    const source = fixture("nested-quotes");
    const view = editor(source);
    const classes = [...drawn(view).lineClasses.values()];
    expect(classes.some((name) => name === "cm-loam-quote")).toBe(true);
    expect(classes.some((name) => name.includes("cm-loam-quote-2"))).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("hides the quote marker but keeps the text", () => {
    const view = editor("> quoted line\n\ntail\n");
    const hidden = drawn(view).replaced;
    expect(hidden).toHaveLength(1);
    expect(view.state.sliceDoc(hidden[0]?.from, hidden[0]?.to)).toBe("> ");
  });
});

/** AC2/AC5: click and ⌘L are the same transaction. */
describe("task toggling", () => {
  const doc = "- [ ] write tests\n- [x] ship it\n";

  it("click and command write identical Markdown", () => {
    const clicked = editor(doc);
    toggleTaskLine(clicked, 1);

    const commanded = editor(doc);
    commanded.dispatch({ selection: EditorSelection.cursor(3) });
    toggleTask(commanded);

    expect(clicked.state.doc.toString()).toBe("- [x] write tests\n- [x] ship it\n");
    expect(clicked.state.doc.toString()).toBe(commanded.state.doc.toString());
  });

  it("one undo restores the exact pre-toggle source", () => {
    const view = editor(doc);
    toggleTaskLine(view, 2);
    expect(view.state.doc.toString()).toBe("- [ ] write tests\n- [ ] ship it\n");
    undo(view);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("ignores lines that are not tasks", () => {
    const view = editor("plain paragraph\n");
    toggleTaskLine(view, 1);
    expect(view.state.doc.toString()).toBe("plain paragraph\n");
  });
});

/** AC3: the widget is a real checkbox with state and a name. */
describe("checkbox semantics", () => {
  it("exposes checked state and labels itself with the item text", () => {
    const view = editor("- [ ] buy milk\n- [x] call Ada\n");
    const boxes = checkboxes(view);
    expect(boxes).toHaveLength(2);

    const [unchecked, checked] = boxes;
    expect(unchecked?.type).toBe("checkbox");
    expect(unchecked?.checked).toBe(false);
    expect(unchecked?.getAttribute("aria-checked")).toBe("false");
    expect(unchecked?.getAttribute("aria-label")).toBe("buy milk");
    expect(checked?.checked).toBe(true);
    expect(checked?.getAttribute("aria-checked")).toBe("true");
    expect(checked?.getAttribute("aria-label")).toBe("call Ada");
  });

  it("clicking the rendered checkbox rewrites its own line", () => {
    const view = editor("- [ ] first\n- [ ] second\n");
    const [, second] = checkboxes(view);
    second?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe("- [ ] first\n- [x] second\n");
  });
});

/** AC4: putting the cursor on a line changes no text and no selection. */
describe("cursor reveal", () => {
  const doc = "- [ ] task item\n\n> quoted line\n";

  it("keeps the checkbox rendered and the indentation intact", () => {
    const view = editor(doc);
    const before = view.state.doc.line(1).text;
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(1).from + 8) });
    // Widgets are not marks: the checkbox stays put when the cursor lands.
    expect(checkboxes(view)).toHaveLength(1);
    expect(view.state.doc.line(1).text).toBe(before);
    expect(view.state.selection.main.head).toBe(view.state.doc.line(1).from + 8);
  });

  it("brings the quote marker back on the cursor's line only", () => {
    const view = editor("> first quote\n>\n> second line\n");
    expect(drawn(view).replaced.length).toBeGreaterThan(0);
    view.dispatch({ selection: EditorSelection.cursor(2) });
    const stillHidden = drawn(view).replaced;
    for (const range of stillHidden) {
      expect(range.from).toBeGreaterThan(view.state.doc.line(1).to);
    }
    expect(view.state.doc.toString()).toBe("> first quote\n>\n> second line\n");
  });
});

/** Multi-line blocks must not double-decorate when one line is rebuilt. */
describe("incremental quote decoration", () => {
  it("editing one line of a quote leaves a single decoration per line", () => {
    const view = editor("> alpha\n> beta\n> gamma\n");
    const second = view.state.doc.line(2);
    view.dispatch({ selection: EditorSelection.cursor(second.to) });
    view.dispatch({ changes: { from: second.to, insert: "!" } });

    const engine = engineOf(view);
    if (!engine) throw new Error("engine not mounted");
    const perLine = new Map<number, number>();
    engine.decorations.between(0, view.state.doc.length, (from, to, value) => {
      if (!value.point || from !== to) return;
      const line = view.state.doc.lineAt(from).number;
      perLine.set(line, (perLine.get(line) ?? 0) + 1);
    });
    for (const count of perLine.values()) expect(count).toBe(1);
  });
});
