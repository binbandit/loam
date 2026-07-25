/**
 * Multicursor, select-next, and Markdown folding (LOA-85, §3.2). CM6 owns
 * the primitives; this module supplies the Markdown fold ranges (headings
 * and list subtrees), the platform modifier for click-multicursor, and a
 * labelled, keyboard-reachable fold control.
 */

import { codeFolding, foldGutter, foldKeymap, foldService } from "@codemirror/language";
import { selectNextOccurrence } from "@codemirror/search";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, type KeyBinding, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { parseListLine } from "./lists";

const HEADING = /^(#{1,6})\s/;

export interface FoldRange {
  from: number;
  to: number;
}

/**
 * The body of a heading: everything until the next heading of the same or
 * higher level. Returns null when there is nothing to hide (AC3).
 */
export function headingFoldRange(state: EditorState, lineStart: number): FoldRange | null {
  const line = state.doc.lineAt(lineStart);
  const match = HEADING.exec(line.text);
  if (!match) return null;
  const level = (match[1] as string).length;
  let end = line.to;
  for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
    const candidate = state.doc.line(number);
    const heading = HEADING.exec(candidate.text);
    if (heading && (heading[1] as string).length <= level) break;
    end = candidate.to;
  }
  return end > line.to ? { from: line.to, to: end } : null;
}

/** A list item's nested children — deeper-indented lines below it. */
export function listFoldRange(state: EditorState, lineStart: number): FoldRange | null {
  const line = state.doc.lineAt(lineStart);
  const parsed = parseListLine(line.text);
  if (!parsed) return null;
  const indent = parsed.indent.length;
  let end = line.to;
  for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
    const candidate = state.doc.line(number);
    if (candidate.text.trim() === "") break;
    const child = parseListLine(candidate.text);
    const childIndent = child
      ? child.indent.length
      : candidate.text.length - candidate.text.trimStart().length;
    if (childIndent <= indent) break;
    end = candidate.to;
  }
  return end > line.to ? { from: line.to, to: end } : null;
}

/** Fold service: headings first, then list subtrees. */
export const markdownFoldService = foldService.of((state, lineStart) => {
  return headingFoldRange(state, lineStart) ?? listFoldRange(state, lineStart);
});

/**
 * AC4: the chevron is a real button with an accessible name, not a bare
 * glyph. Closed markers carry a modifier class so the theme can keep them
 * visible while open ones stay hover-only.
 */
export function foldMarker(open: boolean): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = open ? "loam-fold-marker" : "loam-fold-marker loam-fold-marker-closed";
  button.setAttribute("aria-label", open ? "Fold section" : "Unfold section");
  button.setAttribute("aria-expanded", open ? "true" : "false");
  button.textContent = open ? "⌄" : "›";
  // Clicking the gutter must not pull focus out of the document; the click
  // event still fires, and Tab still reaches the button for keyboard users.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  return button;
}

/**
 * CM6 marks the whole gutter `aria-hidden` because line numbers are noise
 * for assistive tech. Loam's only gutter content is the fold controls, and
 * AC4 requires those to be announced — so the attribute comes back off.
 */
const exposeGutterToAssistiveTech = ViewPlugin.fromClass(
  class {
    private exposed = false;

    constructor(view: EditorView) {
      this.expose(view);
    }

    update(update: ViewUpdate): void {
      this.expose(update.view);
    }

    private expose(view: EditorView): void {
      if (this.exposed) return;
      const gutters = view.dom.querySelector(".cm-gutters");
      if (!gutters) return;
      gutters.removeAttribute("aria-hidden");
      gutters.setAttribute("role", "group");
      gutters.setAttribute("aria-label", "Fold controls");
      this.exposed = true;
    }
  },
);

/** §3.2 multicursor modifier: ⌘-click (Ctrl-click off macOS). */
export const clickMulticursor = EditorView.clickAddsSelectionRange.of(
  (event) => event.metaKey || event.ctrlKey,
);

export const selectNext = selectNextOccurrence;

export const selectionKeymap: KeyBinding[] = [{ key: "Mod-d", run: selectNextOccurrence }];

export function markdownFolding(): Extension {
  return [
    codeFolding(),
    markdownFoldService,
    foldGutter({ markerDOM: foldMarker }),
    exposeGutterToAssistiveTech,
    clickMulticursor,
  ];
}

export const foldingKeymap = foldKeymap;
