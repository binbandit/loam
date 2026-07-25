/**
 * Smart lists and task toggles (LOA-83, §3.2). Pure line-shape parsing —
 * the file always stores plain Markdown list syntax, so these commands only
 * ever rewrite markers, never a hidden model. Each command is one dispatch,
 * so each is one undo step.
 */

import { EditorSelection, type StateCommand } from "@codemirror/state";
import type { KeyBinding } from "@codemirror/view";

export interface ListLine {
  /** Leading whitespace. */
  indent: string;
  /** `-`, `*`, `+`, or `3.` — exactly as written. */
  marker: string;
  /** Ordered-list number, when the marker is numeric. */
  number: number | null;
  /** `" "`, `"x"`, or null when the item is not a task. */
  task: "checked" | "unchecked" | null;
  /** Text after the marker (and checkbox). */
  content: string;
  /** Column where `content` starts. */
  contentColumn: number;
}

const LIST_PATTERN = /^(\s*)([-*+]|\d+[.)])\s+(\[( |x|X)\]\s+)?(.*)$/;

/** Parses a line into its list shape, or null when it is not a list item. */
export function parseListLine(text: string): ListLine | null {
  const match = LIST_PATTERN.exec(text);
  if (!match) return null;
  const [, indent = "", marker = "", checkbox, checkState, content = ""] = match;
  const numeric = /^\d+[.)]$/.test(marker);
  return {
    indent,
    marker,
    number: numeric ? Number.parseInt(marker, 10) : null,
    task: checkbox ? (checkState?.toLowerCase() === "x" ? "checked" : "unchecked") : null,
    content,
    contentColumn: text.length - content.length,
  };
}

function renderMarker(line: ListLine, overrides: Partial<ListLine> = {}): string {
  const merged = { ...line, ...overrides };
  const marker =
    merged.number !== null ? `${merged.number}${merged.marker.slice(-1)}` : merged.marker;
  const checkbox = merged.task ? `[${merged.task === "checked" ? "x" : " "}] ` : "";
  return `${merged.indent}${marker} ${checkbox}`;
}

/**
 * Enter inside a list continues it; Enter on an empty item ends the list
 * (AC1). Ordered lists continue with the next number.
 */
export const continueList: StateCommand = ({ state, dispatch }) => {
  let handled = false;
  const transaction = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    const parsed = parseListLine(line.text);
    if (!parsed || range.head < line.from + parsed.contentColumn) {
      return { range };
    }
    handled = true;

    // Empty item: Enter ends the list by clearing the marker.
    if (parsed.content.trim() === "") {
      return {
        changes: { from: line.from, to: line.to, insert: "" },
        range: EditorSelection.cursor(line.from),
      };
    }

    const next = renderMarker(parsed, {
      number: parsed.number === null ? null : parsed.number + 1,
      // A continued task always starts unchecked.
      task: parsed.task ? "unchecked" : null,
    });
    const insert = `\n${next}`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
  if (!handled) return false;
  dispatch(state.update(transaction, { scrollIntoView: true, userEvent: "input.list" }));
  return true;
};

function shiftIndent(unit: string, outdent: boolean): StateCommand {
  return ({ state, dispatch }) => {
    let handled = false;
    const seen = new Set<number>();
    const changes: { from: number; to?: number; insert?: string }[] = [];
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      for (let number = first; number <= last; number += 1) {
        if (seen.has(number)) continue;
        seen.add(number);
        const line = state.doc.line(number);
        const parsed = parseListLine(line.text);
        if (!parsed) continue;
        handled = true;
        if (outdent) {
          const width = Math.min(parsed.indent.length, unit.length);
          if (width > 0) changes.push({ from: line.from, to: line.from + width });
        } else {
          changes.push({ from: line.from, insert: unit });
        }
      }
    }
    if (!handled || changes.length === 0) return false;
    dispatch(
      state.update({
        changes,
        scrollIntoView: true,
        userEvent: outdent ? "delete" : "input.indent",
      }),
    );
    return true;
  };
}

/** Tab / Shift-Tab inside a list item (AC2); nesting stays valid Markdown. */
export const indentListItem = shiftIndent("  ", false);
export const outdentListItem = shiftIndent("  ", true);

/**
 * Renumbers ordered siblings at each indent level so edits leave a valid
 * sequence (AC3). Returns the rewritten document text.
 */
export function renumberOrderedLists(text: string): string {
  const lines = text.split("\n");
  // Counter per indent width; deeper levels reset when a shallower resumes.
  const counters = new Map<number, number>();
  let previousIndent: number | null = null;
  return lines
    .map((line) => {
      const parsed = parseListLine(line);
      if (!parsed || parsed.number === null) {
        if (line.trim() === "") {
          counters.clear();
          previousIndent = null;
        }
        return line;
      }
      const width = parsed.indent.length;
      if (previousIndent !== null && width < previousIndent) {
        for (const key of [...counters.keys()]) if (key > width) counters.delete(key);
      }
      const next = (counters.get(width) ?? 0) + 1;
      counters.set(width, next);
      previousIndent = width;
      return `${renderMarker(parsed, { number: next })}${parsed.content}`;
    })
    .join("\n");
}

/** Rewrites the document with renumbered ordered lists (one undo step). */
export const renumberOrderedList: StateCommand = ({ state, dispatch }) => {
  const before = state.doc.toString();
  const after = renumberOrderedLists(before);
  if (before === after) return false;
  dispatch(
    state.update({
      changes: { from: 0, to: before.length, insert: after },
      selection: state.selection,
      userEvent: "input.list",
    }),
  );
  return true;
};

/** ⌘L, and the same code path the rendered checkbox click uses (AC4). */
export const toggleTask: StateCommand = ({ state, dispatch }) => {
  let handled = false;
  const changes: { from: number; to: number; insert: string }[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number += 1) {
      if (seen.has(number)) continue;
      seen.add(number);
      const line = state.doc.line(number);
      const parsed = parseListLine(line.text);
      if (!parsed) continue;
      handled = true;
      if (parsed.task === null) {
        // Plain list item becomes an unchecked task.
        const prefix = renderMarker(parsed, { task: "unchecked" });
        changes.push({ from: line.from, to: line.to, insert: `${prefix}${parsed.content}` });
      } else {
        const flipped = parsed.task === "checked" ? "unchecked" : "checked";
        const prefix = renderMarker(parsed, { task: flipped });
        changes.push({ from: line.from, to: line.to, insert: `${prefix}${parsed.content}` });
      }
    }
  }
  if (!handled) return false;
  dispatch(state.update({ changes, userEvent: "input.task" }));
  return true;
};

/** Toggles the task on a specific line — what a checkbox click calls. */
export function toggleTaskAtLine(text: string): string | null {
  const parsed = parseListLine(text);
  if (!parsed) return null;
  const task = parsed.task === "checked" ? "unchecked" : "checked";
  return `${renderMarker(parsed, { task })}${parsed.content}`;
}

/** §3.2 list bindings; E12 makes them remappable. */
export const listKeymap: KeyBinding[] = [
  { key: "Enter", run: continueList },
  { key: "Tab", run: indentListItem },
  { key: "Shift-Tab", run: outdentListItem },
  { key: "Mod-l", run: toggleTask },
];
