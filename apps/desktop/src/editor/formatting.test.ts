/** LOA-79: Markdown-aware formatting, smart pairs, and paste-link. */

import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  isUrl,
  toggleBold,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
} from "./formatting";
import { SessionRegistry } from "./sessions";

let counter = 0;
function editor(doc: string, selection?: { anchor: number; head?: number }) {
  const registry = new SessionRegistry();
  counter += 1;
  const session = registry.open(`note-${counter}.md`, doc, null);
  const view = new EditorView({ state: session.state });
  if (selection) {
    view.dispatch({
      selection: EditorSelection.range(selection.anchor, selection.head ?? selection.anchor),
    });
  }
  return view;
}

/** jsdom has no DataTransfer; the handler only reads `getData`. */
function pasteEvent(text: string): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  return event;
}

/** Typing simulation that goes through the input handler (smart pairs). */
function type(view: EditorView, text: string): void {
  const { from, to } = view.state.selection.main;
  const handled = view.state
    .facet(EditorView.inputHandler)
    .some((handler) => handler(view, from, to, text, () => view.state.update({})) === true);
  if (!handled) {
    view.dispatch(view.state.replaceSelection(text));
  }
}

/** AC1: wrap and unwrap without duplicating markers. */
describe("wrap and unwrap", () => {
  it("bold wraps a selection and unwraps it again", () => {
    const view = editor("make this bold", { anchor: 10, head: 14 });
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("make this **bold**");
    // The selection still covers the word, so a second run unwraps.
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("make this bold");
  });

  it("unwraps when the markers sit just outside the selection", () => {
    const view = editor("a **bold** word", { anchor: 4, head: 8 });
    expect(view.state.sliceDoc(4, 8)).toBe("bold");
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("a bold word");
  });

  it("unwraps when the markers are inside the selection", () => {
    const view = editor("a **bold** word", { anchor: 2, head: 10 });
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("a bold word");
  });

  it("each marker type round-trips", () => {
    const cases: Array<[typeof toggleItalic, string]> = [
      [toggleItalic, "_x_"],
      [toggleStrikethrough, "~~x~~"],
      [toggleHighlight, "==x=="],
      [toggleInlineCode, "`x`"],
    ];
    for (const [command, wrapped] of cases) {
      const view = editor("x", { anchor: 0, head: 1 });
      command(view);
      expect(view.state.doc.toString()).toBe(wrapped);
      command(view);
      expect(view.state.doc.toString()).toBe("x");
    }
  });

  it("applies to every cursor in a multi-selection", () => {
    const view = editor("one two");
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
    });
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("**one** **two**");
  });
});

/** AC2: an empty selection leaves the cursor between the markers. */
describe("empty selection", () => {
  it("places the cursor between fresh markers", () => {
    const view = editor("ab", { anchor: 1 });
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("a****b");
    expect(view.state.selection.main.head).toBe(3);
    // Typing lands inside the markers.
    view.dispatch(view.state.replaceSelection("hi"));
    expect(view.state.doc.toString()).toBe("a**hi**b");
  });
});

/** AC3: pasting a URL over a selection creates one link. */
describe("paste link", () => {
  it("recognises URLs", () => {
    expect(isUrl("https://example.com/x")).toBe(true);
    expect(isUrl("  http://a.b  ")).toBe(true);
    expect(isUrl("mailto:a@b.c")).toBe(true);
    expect(isUrl("not a url")).toBe(false);
    expect(isUrl("example.com")).toBe(false);
  });

  it("wraps the selected text in a Markdown link", () => {
    const view = editor("see the docs", { anchor: 8, head: 12 });
    view.contentDOM.dispatchEvent(pasteEvent("https://loam.app/docs"));
    expect(view.state.doc.toString()).toBe("see the [docs](https://loam.app/docs)");
  });

  it("plain text pastes normally", () => {
    const view = editor("see the docs", { anchor: 8, head: 12 });
    view.contentDOM.dispatchEvent(pasteEvent("manual"));
    // Not intercepted: CM6's own paste replaces the selection as usual.
    expect(view.state.doc.toString()).toBe("see the manual");
  });
});

/** AC4: closing delimiters overtype instead of duplicating. */
describe("smart pairs", () => {
  it("typing a marker with a selection wraps it", () => {
    const view = editor("word", { anchor: 0, head: 4 });
    type(view, "`");
    expect(view.state.doc.toString()).toBe("`word`");
  });

  it("typing the closing delimiter steps over it", () => {
    const view = editor("`x`", { anchor: 2 });
    type(view, "`");
    expect(view.state.doc.toString()).toBe("`x`");
    expect(view.state.selection.main.head).toBe(3);
  });

  it("`[` auto-closes and `[[` produces a wikilink", () => {
    const view = editor("", { anchor: 0 });
    type(view, "[");
    expect(view.state.doc.toString()).toBe("[]");
    type(view, "[");
    expect(view.state.doc.toString()).toBe("[[]]");
    expect(view.state.selection.main.head).toBe(2);
  });

  it("closing bracket overtypes rather than duplicating", () => {
    const view = editor("[x]", { anchor: 2 });
    type(view, "]");
    expect(view.state.doc.toString()).toBe("[x]");
    expect(view.state.selection.main.head).toBe(3);
  });
});

/** AC5: every operation is a single undo step. */
describe("undo granularity", () => {
  it("one undo reverses a whole format command, including multicursor", () => {
    const view = editor("one two");
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
    });
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("**one** **two**");
    undo(view);
    expect(view.state.doc.toString()).toBe("one two");
  });

  it("one undo reverses a paste-link", () => {
    const view = editor("see the docs", { anchor: 8, head: 12 });
    view.contentDOM.dispatchEvent(pasteEvent("https://loam.app"));
    expect(view.state.doc.toString()).toContain("](https://loam.app)");
    undo(view);
    expect(view.state.doc.toString()).toBe("see the docs");
  });
});
