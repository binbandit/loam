/** LOA-85: multicursor, select-next, and heading/list folding. */

import { simplifySelection } from "@codemirror/commands";
import { foldable, foldCode, foldedRanges, unfoldAll } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { foldMarker, headingFoldRange, listFoldRange, selectNext } from "./folding";
import { toggleBold } from "./formatting";
import { toggleTask } from "./lists";
import { SessionRegistry } from "./sessions";

let counter = 0;
function editor(doc: string) {
  const registry = new SessionRegistry();
  counter += 1;
  const session = registry.open(`fold-${counter}.md`, doc, null);
  return new EditorView({ state: session.state });
}

/** Lines are 1-based; returns the document offset the line starts at. */
function lineStart(view: EditorView, number: number): number {
  return view.state.doc.line(number).from;
}

/** Text a fold range would hide; fails loudly when there is no range. */
function hiddenBy(view: EditorView, range: { from: number; to: number } | null): string {
  expect(range).not.toBeNull();
  if (!range) throw new Error("unreachable");
  return view.state.sliceDoc(range.from, range.to);
}

function foldedText(view: EditorView): string[] {
  const hidden: string[] = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    hidden.push(view.state.sliceDoc(from, to));
  });
  return hidden;
}

/** AC1: modifier-click adds a cursor instead of replacing the selection. */
describe("multicursor", () => {
  it("treats ⌘/Ctrl-click as add-range, and a plain click as replace", () => {
    const view = editor("one two three");
    const predicates = view.state.facet(EditorView.clickAddsSelectionRange);
    expect(predicates.length).toBeGreaterThan(0);
    const test = (init: MouseEventInit) =>
      predicates.some((predicate) => predicate(new MouseEvent("mousedown", init)));
    expect(test({ metaKey: true })).toBe(true);
    expect(test({ ctrlKey: true })).toBe(true);
    expect(test({})).toBe(false);
    expect(test({ shiftKey: true })).toBe(false);
  });

  it("keeps existing ranges when another is added", () => {
    const view = editor("one two three");
    view.dispatch({ selection: EditorSelection.range(0, 3) });
    // What clickAddsSelectionRange does once the predicate says yes.
    view.dispatch({
      selection: view.state.selection.addRange(EditorSelection.range(4, 7)),
    });
    expect(
      view.state.selection.ranges.map((range) => view.state.sliceDoc(range.from, range.to)),
    ).toEqual(["one", "two"]);
  });
});

/** AC2: select-next advances; Escape collapses back to one selection. */
describe("select next occurrence", () => {
  it("selects the word, then each following match", () => {
    const view = editor("cat dog cat dog cat");
    view.dispatch({ selection: EditorSelection.cursor(1) });
    expect(selectNext(view)).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(1);
    const { from, to } = view.state.selection.main;
    expect(view.state.sliceDoc(from, to)).toBe("cat");

    selectNext(view);
    expect(view.state.selection.ranges).toHaveLength(2);
    selectNext(view);
    expect(view.state.selection.ranges).toHaveLength(3);
    for (const range of view.state.selection.ranges) {
      expect(view.state.sliceDoc(range.from, range.to)).toBe("cat");
    }
  });

  it("Escape returns to a single selection", () => {
    const view = editor("cat cat cat");
    view.dispatch({ selection: EditorSelection.cursor(0) });
    selectNext(view);
    selectNext(view);
    selectNext(view);
    expect(view.state.selection.ranges).toHaveLength(3);
    simplifySelection(view);
    expect(view.state.selection.ranges).toHaveLength(1);
  });
});

/** AC3: folds hide the body only — never the heading or the next section. */
describe("folding", () => {
  const doc = [
    "# Title",
    "intro",
    "## First",
    "body one",
    "body two",
    "## Second",
    "body three",
  ].join("\n");

  it("a heading folds to the end of its section", () => {
    const view = editor(doc);
    expect(hiddenBy(view, headingFoldRange(view.state, lineStart(view, 3)))).toBe(
      "\nbody one\nbody two",
    );
  });

  it("a top-level heading contains its subsections", () => {
    const view = editor(doc);
    expect(hiddenBy(view, headingFoldRange(view.state, lineStart(view, 1)))).toBe(
      "\nintro\n## First\nbody one\nbody two\n## Second\nbody three",
    );
  });

  it("a trailing heading with no body is not foldable", () => {
    const view = editor("# Title\n## Empty");
    expect(headingFoldRange(view.state, lineStart(view, 2))).toBeNull();
  });

  it("a list item folds only its deeper-indented children", () => {
    const view = editor("- parent\n  - child\n    - grandchild\n- sibling");
    expect(hiddenBy(view, listFoldRange(view.state, lineStart(view, 1)))).toBe(
      "\n  - child\n    - grandchild",
    );
    // A leaf has nothing to hide.
    expect(listFoldRange(view.state, lineStart(view, 4))).toBeNull();
  });

  it("prose lines are not foldable", () => {
    const view = editor("just a paragraph\nand another");
    expect(headingFoldRange(view.state, 0)).toBeNull();
    expect(listFoldRange(view.state, 0)).toBeNull();
  });

  it("the fold service drives CM6's own fold commands", () => {
    const view = editor(doc);
    const line = view.state.doc.line(3);
    expect(foldable(view.state, line.from, line.to)).toMatchObject({ from: line.to });
    view.dispatch({ selection: EditorSelection.cursor(line.from) });
    expect(foldCode(view)).toBe(true);
    expect(foldedText(view)).toEqual(["\nbody one\nbody two"]);
    // The document itself is untouched — folding is a view concern.
    expect(view.state.doc.toString()).toBe(doc);
    unfoldAll(view);
    expect(foldedText(view)).toEqual([]);
  });
});

/** AC4: the gutter control is focusable and named for screen readers. */
describe("fold control", () => {
  it("renders a labelled button in both states", () => {
    const open = foldMarker(true);
    expect(open.tagName).toBe("BUTTON");
    expect(open.getAttribute("aria-label")).toBe("Fold section");
    expect(open.getAttribute("aria-expanded")).toBe("true");
    // Not hidden from assistive tech and reachable in the tab order.
    expect(open.getAttribute("aria-hidden")).toBeNull();
    expect(open.getAttribute("tabindex")).toBeNull();

    const closed = foldMarker(false);
    expect(closed.getAttribute("aria-label")).toBe("Unfold section");
    expect(closed.getAttribute("aria-expanded")).toBe("false");
    // Closed markers stay visible; the theme keys off this class.
    expect(closed.classList.contains("loam-fold-marker-closed")).toBe(true);
  });

  it("un-hides the gutter so screen readers reach the controls", () => {
    const view = editor("# Title\nbody");
    const gutters = view.dom.querySelector(".cm-gutters");
    expect(gutters).not.toBeNull();
    expect(gutters?.hasAttribute("aria-hidden")).toBe(false);
    expect(gutters?.getAttribute("aria-label")).toBe("Fold controls");
  });

  it("does not steal focus from the document on mousedown", () => {
    const marker = foldMarker(true);
    const event = new MouseEvent("mousedown", { cancelable: true, bubbles: true });
    marker.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

/** AC5: formatting stays coherent across every selection. */
describe("multi-selection commands", () => {
  it("bold applies to all ranges from select-next", () => {
    const view = editor("cat dog cat");
    view.dispatch({ selection: EditorSelection.cursor(0) });
    selectNext(view);
    selectNext(view);
    expect(view.state.selection.ranges).toHaveLength(2);
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("**cat** dog **cat**");
  });

  it("task toggle applies to every cursor's line", () => {
    const view = editor("- [ ] a\nfiller\n- [ ] b");
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(3),
        EditorSelection.cursor(view.state.doc.line(3).from + 3),
      ]),
    });
    toggleTask(view);
    expect(view.state.doc.toString()).toBe("- [x] a\nfiller\n- [x] b");
  });
});
