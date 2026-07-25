/** LOA-83: smart lists and task toggles. */

import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  continueList,
  indentListItem,
  outdentListItem,
  parseListLine,
  renumberOrderedList,
  renumberOrderedLists,
  toggleTask,
  toggleTaskAtLine,
} from "./lists";
import { SessionRegistry } from "./sessions";

let counter = 0;
function editor(doc: string, cursor?: number) {
  const registry = new SessionRegistry();
  counter += 1;
  const session = registry.open(`list-${counter}.md`, doc, null);
  const view = new EditorView({ state: session.state });
  view.dispatch({ selection: EditorSelection.cursor(cursor ?? doc.length) });
  return view;
}

describe("line parsing", () => {
  it("reads bullets, ordered items, and tasks", () => {
    expect(parseListLine("- item")).toMatchObject({ marker: "-", number: null, task: null });
    expect(parseListLine("  3. item")).toMatchObject({ indent: "  ", number: 3 });
    expect(parseListLine("- [ ] todo")).toMatchObject({ task: "unchecked", content: "todo" });
    expect(parseListLine("- [x] done")).toMatchObject({ task: "checked", content: "done" });
    expect(parseListLine("plain text")).toBeNull();
    expect(parseListLine("")).toBeNull();
  });
});

/** AC1: Enter continues the marker; an empty item ends the list. */
describe("Enter continuation", () => {
  it("continues a bullet list", () => {
    const view = editor("- one");
    continueList(view);
    expect(view.state.doc.toString()).toBe("- one\n- ");
  });

  it("continues an ordered list with the next number", () => {
    const view = editor("1. one");
    continueList(view);
    expect(view.state.doc.toString()).toBe("1. one\n2. ");
  });

  it("continues a task as unchecked, even from a checked item", () => {
    const view = editor("- [x] done");
    continueList(view);
    expect(view.state.doc.toString()).toBe("- [x] done\n- [ ] ");
  });

  it("preserves nesting indentation", () => {
    const view = editor("  - nested");
    continueList(view);
    expect(view.state.doc.toString()).toBe("  - nested\n  - ");
  });

  it("an empty item ends the list", () => {
    const view = editor("- one\n- ");
    continueList(view);
    expect(view.state.doc.toString()).toBe("- one\n");
  });

  it("returns false outside a list so the default Enter applies", () => {
    const view = editor("plain paragraph");
    expect(continueList(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("plain paragraph");
  });
});

/** AC2: indent/outdent keeps the Markdown valid. */
describe("indent and outdent", () => {
  it("indents and outdents a list item", () => {
    const view = editor("- one\n- two", 8);
    indentListItem(view);
    expect(view.state.doc.toString()).toBe("- one\n  - two");
    outdentListItem(view);
    expect(view.state.doc.toString()).toBe("- one\n- two");
  });

  it("outdent at the left margin is a no-op that falls through", () => {
    const view = editor("- one", 3);
    expect(outdentListItem(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("- one");
  });

  it("indents every list line in a multi-line selection", () => {
    const view = editor("- one\n- two\n- three");
    view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) });
    indentListItem(view);
    expect(view.state.doc.toString()).toBe("  - one\n  - two\n  - three");
  });

  it("leaves non-list lines alone", () => {
    const view = editor("text", 2);
    expect(indentListItem(view)).toBe(false);
  });
});

/** AC3: ordered siblings renumber after edits. */
describe("renumbering", () => {
  it("fixes a broken sequence at one level", () => {
    expect(renumberOrderedLists("1. a\n1. b\n5. c")).toBe("1. a\n2. b\n3. c");
  });

  it("numbers nested levels independently", () => {
    const input = "1. a\n  1. a1\n  7. a2\n3. b";
    expect(renumberOrderedLists(input)).toBe("1. a\n  1. a1\n  2. a2\n2. b");
  });

  it("keeps bullets and prose untouched", () => {
    const input = "- bullet\ntext\n2. one\n9. two";
    expect(renumberOrderedLists(input)).toBe("- bullet\ntext\n1. one\n2. two");
  });

  it("preserves the `)` delimiter style and task checkboxes", () => {
    expect(renumberOrderedLists("4) a\n9) b")).toBe("1) a\n2) b");
    expect(renumberOrderedLists("3. [x] a\n3. [ ] b")).toBe("1. [x] a\n2. [ ] b");
  });

  it("renumbering the document is one undoable command", () => {
    const view = editor("1. a\n1. b\n1. c");
    expect(renumberOrderedList(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("1. a\n2. b\n3. c");
    undo(view);
    expect(view.state.doc.toString()).toBe("1. a\n1. b\n1. c");
  });
});

/** AC4: the command and a checkbox click write identical source. */
describe("task toggling", () => {
  it("toggles unchecked ↔ checked", () => {
    const view = editor("- [ ] todo", 3);
    toggleTask(view);
    expect(view.state.doc.toString()).toBe("- [x] todo");
    toggleTask(view);
    expect(view.state.doc.toString()).toBe("- [ ] todo");
  });

  it("turns a plain list item into a task", () => {
    const view = editor("- item", 3);
    toggleTask(view);
    expect(view.state.doc.toString()).toBe("- [ ] item");
  });

  it("the click path produces the same source as the command", () => {
    const line = "  - [ ] nested todo";
    const clicked = toggleTaskAtLine(line);
    const view = editor(line, 5);
    toggleTask(view);
    expect(clicked).toBe("  - [x] nested todo");
    expect(view.state.doc.toString()).toBe(clicked);
    expect(toggleTaskAtLine("plain")).toBeNull();
  });

  it("toggles every task in a selection", () => {
    const view = editor("- [ ] a\n- [ ] b");
    view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) });
    toggleTask(view);
    expect(view.state.doc.toString()).toBe("- [x] a\n- [x] b");
  });
});

/** AC5: every list operation is a single undo step. */
describe("undo granularity", () => {
  it("one undo reverses continuation, indent, and toggle", () => {
    const view = editor("- one");
    continueList(view);
    expect(view.state.doc.toString()).toBe("- one\n- ");
    undo(view);
    expect(view.state.doc.toString()).toBe("- one");

    view.dispatch({ selection: EditorSelection.cursor(3) });
    indentListItem(view);
    expect(view.state.doc.toString()).toBe("  - one");
    undo(view);
    expect(view.state.doc.toString()).toBe("- one");

    toggleTask(view);
    expect(view.state.doc.toString()).toBe("- [ ] one");
    undo(view);
    expect(view.state.doc.toString()).toBe("- one");
  });
});
