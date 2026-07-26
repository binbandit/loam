/**
 * List, task, and blockquote families (LOA-107, §3.3). Structure that a
 * reader needs — bullets, checkboxes, quote borders — rather than the inline
 * marks LOA-102 hides.
 *
 * The checkbox is a *widget*, not a formatting mark, so it stays rendered
 * even on the cursor's line: §3.2 lists widgets separately from the marks
 * that hide and reveal, and a checkbox that vanished the moment you clicked
 * it would be unusable. Clicking it runs the exact transaction ⌘L runs
 * (`toggleTaskAtLine`), so both paths write byte-identical Markdown and both
 * are one undo step.
 */

import type { EditorView } from "@codemirror/view";
import { Decoration, WidgetType } from "@codemirror/view";
import { toggleTaskAtLine } from "../lists";
import type { FamilyContext, SyntaxFamily } from "./engine";

const hide = Decoration.replace({});

/** Bullet and ordered markers keep their source width — only the ink changes. */
const listMark = Decoration.mark({ class: "cm-loam-list-mark" });

export const listFamily: SyntaxFamily = {
  name: "lists",
  nodes: ["ListMark"],
  decorate(node, context) {
    context.add(node.from, node.to, listMark);
  },
};

/** Replaces `[ ]`/`[x]` with a real checkbox bound to the source line. */
class TaskWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly line: number,
    private readonly label: string,
  ) {
    super();
  }

  override eq(other: TaskWidget): boolean {
    return other.checked === this.checked && other.line === this.line && other.label === this.label;
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-loam-task";
    box.checked = this.checked;
    // AC3: state and name, not a bare glyph — and never color alone.
    box.setAttribute("aria-checked", this.checked ? "true" : "false");
    box.setAttribute("aria-label", this.label || "Task");
    box.addEventListener("mousedown", (event) => event.preventDefault());
    box.addEventListener("click", (event) => {
      event.preventDefault();
      toggleTaskLine(view, this.line);
    });
    return box;
  }

  override ignoreEvent(): boolean {
    // Let the widget handle its own clicks instead of moving the cursor.
    return false;
  }
}

/**
 * AC2/AC5: the click path *is* the ⌘L path — same rewrite, one transaction,
 * so one undo restores the exact pre-toggle source.
 */
export function toggleTaskLine(view: EditorView, lineNumber: number): void {
  if (lineNumber < 1 || lineNumber > view.state.doc.lines) return;
  const line = view.state.doc.line(lineNumber);
  const next = toggleTaskAtLine(line.text);
  if (next === null) return;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: next },
    userEvent: "input.task",
  });
}

export const taskFamily: SyntaxFamily = {
  name: "tasks",
  nodes: ["TaskMarker"],
  decorate(node, context) {
    const marker = context.state.sliceDoc(node.from, node.to);
    const checked = /\[x\]/i.test(marker);
    const line = context.state.doc.lineAt(node.from);
    // The item's text is the checkbox's name, so a screen reader hears what
    // is being checked rather than "checkbox, blank".
    const label = context.state.sliceDoc(node.to, line.to).trim();
    context.add(
      node.from,
      node.to,
      Decoration.replace({ widget: new TaskWidget(checked, line.number, label) }),
    );
  },
};

/** Nesting depth of a blockquote node (1 for a top-level quote). */
function quoteDepth(node: { node: { parent: unknown } }): number {
  let depth = 1;
  let parent = (node.node as { parent: { name: string; parent: unknown } | null }).parent;
  while (parent) {
    if (parent.name === "Blockquote") depth += 1;
    parent = (parent as { parent: { name: string; parent: unknown } | null }).parent;
  }
  return Math.min(depth, 3);
}

export const quoteFamily: SyntaxFamily = {
  name: "quotes",
  nodes: ["Blockquote", "QuoteMark"],

  decorate(node, context) {
    if (node.name === "QuoteMark") {
      // The border carries the quote, so the `>` goes — except on the
      // cursor's line, where the raw source comes back like any other mark.
      if (context.revealed(node.from, node.to)) return;
      const line = context.state.doc.lineAt(node.from);
      let end = node.to;
      while (end < line.to && context.state.sliceDoc(end, end + 1) === " ") end += 1;
      context.add(node.from, end, hide);
      return;
    }

    // Depth is drawn with an indent step *and* a border, never color alone.
    const depth = quoteDepth(node as unknown as { node: { parent: unknown } });
    const decoration = QUOTE_LINE[depth - 1] ?? QUOTE_LINE[0];
    if (!decoration) return;
    const first = context.state.doc.lineAt(node.from).number;
    const last = context.state.doc.lineAt(node.to).number;
    for (let number = first; number <= last; number += 1) {
      const line = context.state.doc.line(number);
      context.add(line.from, line.from, decoration);
    }
  },
};

const QUOTE_LINE = [
  Decoration.line({ class: "cm-loam-quote" }),
  Decoration.line({ class: "cm-loam-quote cm-loam-quote-2" }),
  Decoration.line({ class: "cm-loam-quote cm-loam-quote-3" }),
];

/** Structure families, in application order. */
export const BLOCK_FAMILIES: readonly SyntaxFamily[] = [listFamily, taskFamily, quoteFamily];

/** Exposed for tests: what a family context looks like to these rules. */
export type { FamilyContext };
