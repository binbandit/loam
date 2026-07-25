/**
 * Live Preview decoration engine (LOA-95, §3.2/§3.3). E10 grows syntax
 * family by syntax family behind independent flags; this module is the part
 * they all share.
 *
 * Three properties the families depend on:
 *   - **Nothing is ever written.** Decorations only change what CM6 draws;
 *     the document keeps the exact Markdown the user typed, so disabling
 *     every family is byte-identical to Source mode.
 *   - **Only dirty spans are rebuilt.** An ordinary keystroke re-decorates
 *     the edited lines and the lines the cursor entered or left — never the
 *     document, and never the whole viewport.
 *   - **One family cannot break the editor.** A decorator that throws is
 *     disabled and its decorations dropped; the rest keep rendering and the
 *     source stays editable.
 */

import { syntaxTree } from "@codemirror/language";
import {
  Compartment,
  type EditorState,
  type Extension,
  Facet,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration as Deco,
  type Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";

export interface Span {
  from: number;
  to: number;
}

/** What a family may do while decorating one syntax node. */
export interface FamilyContext {
  state: EditorState;
  /**
   * True when the range sits on a line the cursor or a selection touches —
   * families leave those marks raw so the source is always reachable.
   */
  revealed(from: number, to: number): boolean;
  add(from: number, to: number, decoration: Decoration): void;
}

/** One syntax family: the Lezer nodes it claims and what it draws for them. */
export interface SyntaxFamily {
  /** Stable id; also the flag name (LOA-102+ register the real families). */
  name: string;
  /** Lezer node names this family decorates. */
  nodes: readonly string[];
  decorate(node: SyntaxNodeRef, context: FamilyContext): void;
}

/** Families the current configuration enables. */
const familyFacet = Facet.define<readonly SyntaxFamily[], readonly SyntaxFamily[]>({
  combine: (values) => values.flat(),
});

/** Raised when a family throws; the field below remembers the casualty. */
const disableFamily = StateEffect.define<string>();

export const disabledFamilies = StateField.define<ReadonlySet<string>>({
  create: () => new Set<string>(),
  update(current, transaction) {
    let next = current;
    for (const effect of transaction.effects) {
      if (effect.is(disableFamily) && !next.has(effect.value)) {
        next = new Set(next).add(effect.value);
      }
    }
    return next;
  },
});

/** Lines any selection touches; families keep these ranges raw (AC3). */
export function revealedSpans(state: EditorState): Span[] {
  const spans: Span[] = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from);
    const last = range.to === range.from ? first : state.doc.lineAt(range.to);
    spans.push({ from: first.from, to: last.to });
  }
  return spans;
}

function overlaps(spans: readonly Span[], from: number, to: number): boolean {
  return spans.some((span) => from <= span.to && to >= span.from);
}

/** Sorted, non-overlapping union. */
function merge(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}

/** Union of `spans` clipped to `bounds`, merged and sorted. */
function clip(spans: readonly Span[], bounds: readonly Span[]): Span[] {
  const clipped: Span[] = [];
  for (const span of spans) {
    for (const bound of bounds) {
      const from = Math.max(span.from, bound.from);
      const to = Math.min(span.to, bound.to);
      if (from <= to) clipped.push({ from, to });
    }
  }
  return merge(clipped);
}

/** The parts of `bounds` that `covered` does not already account for. */
function subtract(bounds: readonly Span[], covered: readonly Span[]): Span[] {
  const gaps: Span[] = [];
  for (const bound of bounds) {
    let at = bound.from;
    for (const span of merge(covered)) {
      if (span.to < at || span.from > bound.to) continue;
      if (span.from > at) gaps.push({ from: at, to: Math.min(span.from, bound.to) });
      at = Math.max(at, span.to);
    }
    if (at < bound.to) gaps.push({ from: at, to: bound.to });
  }
  return merge(gaps);
}

/** Grows a range to whole lines: decoration decisions are per line. */
function lineSpan(state: EditorState, from: number, to: number): Span {
  return { from: state.doc.lineAt(from).from, to: state.doc.lineAt(Math.max(from, to)).to };
}

class PreviewEngine {
  decorations: DecorationSet = Deco.none;
  /** AC2 seam: the spans the last update actually re-decorated. */
  lastBuilt: Span[] = [];
  /** AC5 seam: families disabled by an exception, in order. */
  readonly failures: string[] = [];
  /** Spans currently decorated and up to date; always inside the viewport. */
  private covered: Span[] = [];

  constructor(view: EditorView) {
    this.rebuild(view, [...view.visibleRanges]);
  }

  update(update: ViewUpdate): void {
    const flagsChanged =
      update.startState.facet(familyFacet) !== update.state.facet(familyFacet) ||
      update.startState.field(disabledFamilies) !== update.state.field(disabledFamilies);

    // A flag flip changes what every family draws, so everything on screen
    // is rebuilt. This is not on the keystroke path.
    if (flagsChanged) {
      this.decorations = Deco.none;
      this.covered = [];
      this.rebuild(update.view, [...update.view.visibleRanges]);
      return;
    }

    // Existing decorations survive the edit; only the dirty spans are redone.
    this.decorations = this.decorations.map(update.changes);
    this.covered = this.covered.map((span) => ({
      from: update.changes.mapPos(span.from),
      to: update.changes.mapPos(span.to, 1),
    }));

    const dirty: Span[] = [];
    if (update.docChanged) {
      update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        dirty.push(lineSpan(update.state, fromB, toB));
      });
    }
    // Lines the cursor left or entered flip between raw and rendered.
    if (update.selectionSet || update.docChanged) {
      for (const span of revealedSpans(update.startState)) {
        dirty.push(
          lineSpan(
            update.state,
            update.changes.mapPos(span.from),
            update.changes.mapPos(span.to, 1),
          ),
        );
      }
      for (const span of revealedSpans(update.state)) dirty.push(span);
    }
    // Whatever scrolled (or grew) into view and was never decorated. Doing
    // this by difference is what keeps an edit off the full-viewport path:
    // a growing document does not count as newly visible text.
    dirty.push(...subtract([...update.view.visibleRanges], this.covered));

    if (dirty.length === 0) {
      this.lastBuilt = [];
      return;
    }
    this.rebuild(update.view, dirty);
  }

  private rebuild(view: EditorView, spans: readonly Span[]): void {
    const visible = [...view.visibleRanges];
    const target = clip(spans, visible);
    this.lastBuilt = target;
    // Anything scrolled out stops being "covered": it is rebuilt on return,
    // before it is ever drawn again.
    this.covered = merge([...clip(this.covered, visible), ...target]);
    if (target.length === 0) return;
    const additions: Range<Decoration>[] = [];
    for (const span of target) additions.push(...this.collect(view, span));
    const from = target[0]?.from ?? 0;
    const to = target.at(-1)?.to ?? 0;
    this.decorations = this.decorations.update({
      filterFrom: from,
      filterTo: to,
      // Drop what we are about to replace; everything outside stays put.
      filter: (start, end) => !overlaps(target, start, end),
      add: additions,
      sort: true,
    });
  }

  private collect(view: EditorView, span: Span): Range<Decoration>[] {
    const state = view.state;
    const disabled = state.field(disabledFamilies);
    const families = state.facet(familyFacet).filter((family) => !disabled.has(family.name));
    if (families.length === 0) return [];

    const routes = new Map<string, SyntaxFamily[]>();
    for (const family of families) {
      for (const node of family.nodes) {
        const existing = routes.get(node);
        if (existing) existing.push(family);
        else routes.set(node, [family]);
      }
    }

    const reveal = revealedSpans(state);
    const out: Range<Decoration>[] = [];
    const context: FamilyContext = {
      state,
      revealed: (from, to) => overlaps(reveal, from, to),
      add: (from, to, decoration) => {
        if (from <= to) out.push(decoration.range(from, to));
      },
    };

    syntaxTree(state).iterate({
      from: span.from,
      to: span.to,
      enter: (node) => {
        const targets = routes.get(node.name);
        if (!targets) return;
        for (const family of targets) {
          // AC5: a throwing family loses this node's output and is retired;
          // the document is never touched, so the source stays editable.
          const mark = out.length;
          try {
            family.decorate(node, context);
          } catch (error) {
            out.length = mark;
            this.fail(view, family, error);
          }
        }
      },
    });
    return out;
  }

  private fail(view: EditorView, family: SyntaxFamily, error: unknown): void {
    if (this.failures.includes(family.name)) return;
    this.failures.push(family.name);
    console.error(`Live Preview family "${family.name}" failed; disabling it.`, error);
    // A view update may not dispatch into itself.
    queueMicrotask(() => view.dispatch({ effects: disableFamily.of(family.name) }));
  }
}

const engine = ViewPlugin.fromClass(PreviewEngine, {
  decorations: (plugin) => plugin.decorations,
});

/** Swappable so flags toggle without recreating the editor state (AC1). */
export const livePreviewCompartment = new Compartment();

/** The engine plus the families it should draw; pass [] for pure Source. */
export function livePreview(families: readonly SyntaxFamily[] = []): Extension {
  return [disabledFamilies, familyFacet.of(families), engine];
}

/** Reconfigures the enabled families in place (AC1). */
export function setLivePreviewFamilies(view: EditorView, families: readonly SyntaxFamily[]): void {
  view.dispatch({
    effects: livePreviewCompartment.reconfigure(livePreview(families)),
  });
}

export function enabledFamilies(state: EditorState): readonly SyntaxFamily[] {
  const disabled = state.field(disabledFamilies, false) ?? new Set<string>();
  return state.facet(familyFacet).filter((family) => !disabled.has(family.name));
}

/** Test/inspection handle on the live engine. */
export function engineOf(view: EditorView): PreviewEngine | null {
  return view.plugin(engine);
}

/**
 * The families Live Preview renders. Empty until LOA-102 registers headings
 * and inline emphasis; with none registered the editor is Source, exactly.
 */
export const MARKDOWN_FAMILIES: readonly SyntaxFamily[] = [];
