/**
 * Screen-reader announcements for editor state that is otherwise only
 * visible (LOA-90, §4.6). CM6 owns an `aria-live` region (`.cm-announced`);
 * this plugin feeds it the two things a sighted user reads off the screen —
 * how many selections exist, and whether a section just folded.
 *
 * Announcements are dispatched from a microtask because a view update may
 * not dispatch into itself.
 */

import { foldedRanges } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

export function announce(view: EditorView, message: string): void {
  view.dispatch({ effects: EditorView.announce.of(message) });
}

/** "3 selections" / "1 selection" — what multicursor commands changed. */
export function describeSelection(count: number): string {
  return count === 1 ? "1 selection" : `${count} selections`;
}

/** "Match 3 of 12" / "No results" — used by the find panel (LOA-74). */
export function describeMatches(current: number, total: number): string {
  return total === 0 ? "No results" : `Match ${current} of ${total}`;
}

function foldCount(state: EditorState): number {
  let count = 0;
  foldedRanges(state).between(0, state.doc.length, () => {
    count += 1;
  });
  return count;
}

export const editorAnnouncements = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate): void {
      const messages: string[] = [];

      const before = update.startState.selection.ranges.length;
      const after = update.state.selection.ranges.length;
      // Only multi-range changes are worth saying out loud; ordinary cursor
      // movement is already announced by the platform.
      if (before !== after && (before > 1 || after > 1)) {
        messages.push(describeSelection(after));
      }

      const foldsBefore = foldCount(update.startState);
      const foldsAfter = foldCount(update.state);
      if (foldsAfter > foldsBefore) messages.push("Section folded");
      else if (foldsAfter < foldsBefore) messages.push("Section unfolded");

      if (messages.length === 0) return;
      const view = update.view;
      queueMicrotask(() => {
        for (const message of messages) announce(view, message);
      });
    }
  },
);
