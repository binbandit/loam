/**
 * Markdown-aware formatting and smart pairs (LOA-79, §3.2). Every command
 * is one dispatch, so it is one undo step, and every command maps over all
 * selection ranges so multicursor works. Wrapping is idempotent: running a
 * command on already-wrapped text unwraps instead of doubling markers.
 */

import type { ChangeSpec, EditorState, Extension, StateCommand } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import { EditorView, type KeyBinding } from "@codemirror/view";

/** §3.2 inline markers. */
export const MARKERS = {
  bold: "**",
  italic: "_",
  strikethrough: "~~",
  highlight: "==",
  code: "`",
} as const;

export type MarkerName = keyof typeof MARKERS;

interface RangeEdit {
  changes: ChangeSpec;
  range: ReturnType<typeof EditorSelection.range> | ReturnType<typeof EditorSelection.cursor>;
}

/**
 * Wrap/unwrap `marker` around each range. Markers already inside OR just
 * outside the selection are removed rather than duplicated (AC1); an empty
 * selection leaves the cursor between fresh markers (AC2).
 */
export function toggleMarker(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const width = marker.length;
    const transaction = state.changeByRange((range) => {
      const { from, to } = range;
      const selected = state.sliceDoc(from, to);

      // Markers inside the selection: "**bold**" → "bold".
      if (
        selected.length >= width * 2 &&
        selected.startsWith(marker) &&
        selected.endsWith(marker)
      ) {
        const inner = selected.slice(width, selected.length - width);
        return {
          changes: { from, to, insert: inner },
          range: EditorSelection.range(from, from + inner.length),
        } satisfies RangeEdit;
      }

      // Markers hugging the selection: "**|bold|**" → "bold".
      const before = state.sliceDoc(Math.max(0, from - width), from);
      const after = state.sliceDoc(to, Math.min(state.doc.length, to + width));
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: from - width, to: from },
            { from: to, to: to + width },
          ],
          // Both markers vanish, so the selection shifts left by one marker.
          range: range.empty
            ? EditorSelection.cursor(from - width)
            : EditorSelection.range(from - width, to - width),
        } satisfies RangeEdit;
      }

      // Otherwise wrap.
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: range.empty
          ? EditorSelection.cursor(from + width)
          : EditorSelection.range(from + width, to + width),
      } satisfies RangeEdit;
    });
    if (transaction.changes.empty) return false;
    dispatch(state.update(transaction, { scrollIntoView: true, userEvent: "input.format" }));
    return true;
  };
}

export const toggleBold = toggleMarker(MARKERS.bold);
export const toggleItalic = toggleMarker(MARKERS.italic);
export const toggleStrikethrough = toggleMarker(MARKERS.strikethrough);
export const toggleHighlight = toggleMarker(MARKERS.highlight);
export const toggleInlineCode = toggleMarker(MARKERS.code);

/** §3.2 defaults; the full remappable hotkey system lands in E12. */
export const formattingKeymap: KeyBinding[] = [
  { key: "Mod-b", run: toggleBold },
  { key: "Mod-i", run: toggleItalic },
  { key: "Mod-Shift-x", run: toggleStrikethrough },
  { key: "Mod-Shift-h", run: toggleHighlight },
  { key: "Mod-e", run: toggleInlineCode },
];

const URL_PATTERN = /^(https?:\/\/|mailto:)\S+$/i;

export function isUrl(text: string): boolean {
  return URL_PATTERN.test(text.trim());
}

/** AC3: pasting a URL over selected text creates one Markdown link. */
export function pasteLink(): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const pasted = event.clipboardData?.getData("text/plain") ?? "";
      if (!isUrl(pasted)) return false;
      if (view.state.selection.ranges.every((range) => range.empty)) return false;
      const url = pasted.trim();
      const transaction = view.state.changeByRange((range) => {
        if (range.empty) return { range };
        const text = view.state.sliceDoc(range.from, range.to);
        const insert = `[${text}](${url})`;
        return {
          changes: { from: range.from, to: range.to, insert },
          range: EditorSelection.cursor(range.from + insert.length),
        };
      });
      event.preventDefault();
      view.dispatch(view.state.update(transaction, { userEvent: "input.paste" }));
      return true;
    },
  });
}

/** Characters that wrap a selection when typed, and overtype when closing. */
const PAIR_CHARS = new Set(["*", "_", "=", "`", "~"]);

/**
 * Smart pairs (§3.2): typing a marker with text selected wraps it; typing a
 * closing delimiter that is already right of the cursor steps over it
 * instead of duplicating (AC4); `[` auto-closes, so `[[` yields `[[]]`.
 */
export function smartPairs(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    const state = view.state;
    if (text.length !== 1) return false;

    // Wrap a non-empty selection in the typed marker.
    if (PAIR_CHARS.has(text) && state.selection.ranges.some((range) => !range.empty)) {
      const transaction = state.changeByRange((range) => {
        if (range.empty) return { range };
        return {
          changes: [
            { from: range.from, insert: text },
            { from: range.to, insert: text },
          ],
          range: EditorSelection.range(range.from + 1, range.to + 1),
        };
      });
      view.dispatch(state.update(transaction, { userEvent: "input.type" }));
      return true;
    }

    if (from !== to) return false;
    const next = state.sliceDoc(from, from + 1);

    // Overtype: the delimiter is already there, so just step over it.
    if ((PAIR_CHARS.has(text) || text === "]" || text === ")") && next === text) {
      view.dispatch({ selection: EditorSelection.cursor(from + 1), userEvent: "move.overtype" });
      return true;
    }

    // `[` auto-closes; typing it again inside gives the wikilink `[[|]]`.
    if (text === "[") {
      const insert = next === "]" ? "[]" : "[]";
      view.dispatch({
        changes: { from, insert },
        selection: EditorSelection.cursor(from + 1),
        userEvent: "input.type",
      });
      return true;
    }
    return false;
  });
}

/** Convenience for tests: the document text of a state. */
export function docOf(state: EditorState): string {
  return state.doc.toString();
}
