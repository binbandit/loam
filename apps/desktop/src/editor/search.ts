/**
 * Find/replace plumbing (LOA-74, §3.2). CM6's search extension does the
 * matching; Loam supplies the panel (shell/FindPanel.tsx) so the controls
 * are E07 primitives on §4.2 tokens. These helpers are the seam both the
 * panel and the tests drive.
 */

import {
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { type EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

export interface FindOptions {
  search: string;
  replace?: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regexp?: boolean;
}

export interface MatchCount {
  /** 1-based index of the match at/after the cursor; 0 when none. */
  current: number;
  total: number;
}

export function buildQuery(options: FindOptions): SearchQuery {
  return new SearchQuery({
    search: options.search,
    replace: options.replace ?? "",
    caseSensitive: options.caseSensitive ?? false,
    wholeWord: options.wholeWord ?? false,
    regexp: options.regexp ?? false,
  });
}

/** Regex validity, checked before anything touches the document (AC3). */
export function regexError(pattern: string, enabled: boolean): string | null {
  if (!enabled || pattern === "") return null;
  try {
    new RegExp(pattern);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid regular expression";
  }
}

/** Applies a query; invalid regex is rejected without dispatching. */
export function applyQuery(view: EditorView, options: FindOptions): string | null {
  const error = regexError(options.search, options.regexp ?? false);
  if (error) return error;
  view.dispatch({ effects: setSearchQuery.of(buildQuery(options)) });
  return null;
}

/** Match count + the 1-based position of the selection's match (AC2). */
export function countMatches(state: EditorState): MatchCount {
  const query = getSearchQuery(state);
  if (!query.search || !query.valid) return { current: 0, total: 0 };
  const cursor = query.getCursor(state);
  const head = state.selection.main.from;
  let total = 0;
  let current = 0;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total += 1;
    if (current === 0 && next.value.from >= head) current = total;
  }
  // Cursor past the last match wraps to the first (CM6 search wraps too).
  if (current === 0 && total > 0) current = 1;
  return { current, total };
}

export const findNextMatch = findNext;
export const findPreviousMatch = findPrevious;
export const replaceCurrent = replaceNext;
export const replaceEvery = replaceAll;

/**
 * Highlight-all (§3.2). CM6 only decorates matches while its own panel is
 * open, and Loam renders its own — so this plugin marks every match of the
 * live query across the viewport.
 */
const matchMark = Decoration.mark({ class: "cm-searchMatch" });

function buildMatchDecorations(view: EditorView): DecorationSet {
  const query = getSearchQuery(view.state);
  if (!query.search || !query.valid) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const cursor = query.getCursor(view.state, from, to);
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      builder.add(next.value.from, next.value.to, matchMark);
    }
  }
  return builder.finish();
}

export const highlightAllMatches = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildMatchDecorations(view);
    }

    update(update: ViewUpdate): void {
      const queryChanged = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setSearchQuery)),
      );
      if (update.docChanged || update.viewportChanged || queryChanged) {
        this.decorations = buildMatchDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
