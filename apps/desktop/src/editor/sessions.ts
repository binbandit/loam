/**
 * Editor session registry (LOA-68, D3). One `EditorState` per note path —
 * held here, not in React — so switching tabs restores the exact selection
 * and undo history, and ordinary parent re-renders can never recreate a
 * document. `stateCreations` is the test seam for AC2.
 *
 * The state a session holds is authoritative: `EditorView` instances come
 * and go with mounts, and `capture()` writes the live state back before a
 * view is torn down.
 */

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  keymap,
  rectangularSelection,
} from "@codemirror/view";
import { formattingKeymap, pasteLink, smartPairs } from "./formatting";
import { listKeymap } from "./lists";
import { highlightAllMatches } from "./search";
import { loamAppearance } from "./theme";

/** Compartments are how live reconfiguration happens without a new state. */
export interface SessionCompartments {
  readOnly: Compartment;
  appearance: Compartment;
}

export interface EditorSession {
  path: string;
  state: EditorState;
  /** Hash the content was read at; LOA-69 advances it on save. */
  baseHash: string | null;
  compartments: SessionCompartments;
}

export interface SessionOptions {
  readOnly?: boolean;
  /** Extra extensions (find/replace, formatting, … land in later stories). */
  extensions?: Extension[];
}

/** Base Source-mode extensions (§3.2 baseline; Live Preview is E10). */
export function sourceExtensions(): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    highlightActiveLine(),
    indentOnInput(),
    bracketMatching(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    // Matching only — Loam renders its own panel (LOA-74, §4.3).
    search({ literal: true }),
    highlightAllMatches,
    highlightSelectionMatches(),
    markdown(),
    smartPairs(),
    pasteLink(),
    // List bindings come first: Enter/Tab fall through to the defaults
    // when the cursor is not in a list.
    keymap.of([...listKeymap, ...formattingKeymap, ...defaultKeymap, ...historyKeymap]),
  ];
}

export class SessionRegistry {
  private readonly sessions = new Map<string, EditorSession>();
  /** Live views by path — how commands (find/replace, formatting) reach the
   * editor. One view per path: two panes showing one note share a session,
   * and the most recently mounted view is the command target. */
  private readonly views = new Map<string, EditorView>();
  /** AC2 seam: how many EditorStates this registry has created. */
  stateCreations = 0;

  /** Existing session for `path`, or a fresh one from `doc`. */
  open(path: string, doc: string, baseHash: string | null, options: SessionOptions = {}) {
    const existing = this.sessions.get(path);
    if (existing) return existing;

    const compartments: SessionCompartments = {
      readOnly: new Compartment(),
      appearance: new Compartment(),
    };
    const state = EditorState.create({
      doc,
      extensions: [
        ...sourceExtensions(),
        ...(options.extensions ?? []),
        compartments.appearance.of(loamAppearance()),
        compartments.readOnly.of(readOnlyExtension(options.readOnly ?? false)),
      ],
    });
    this.stateCreations += 1;
    const session: EditorSession = { path, state, baseHash, compartments };
    this.sessions.set(path, session);
    return session;
  }

  get(path: string): EditorSession | undefined {
    return this.sessions.get(path);
  }

  attach(path: string, view: EditorView): void {
    this.views.set(path, view);
  }

  detach(path: string, view: EditorView): void {
    if (this.views.get(path) === view) this.views.delete(path);
  }

  viewOf(path: string): EditorView | undefined {
    return this.views.get(path);
  }

  /** Writes the live state back (called on unmount and on every change). */
  capture(path: string, state: EditorState): void {
    const session = this.sessions.get(path);
    if (session) session.state = state;
  }

  setBaseHash(path: string, hash: string | null): void {
    const session = this.sessions.get(path);
    if (session) session.baseHash = hash;
  }

  /** Drops a session (tab closed); its history is intentionally discarded. */
  close(path: string): void {
    this.sessions.delete(path);
  }

  has(path: string): boolean {
    return this.sessions.has(path);
  }
}

export function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

/** One registry per app; tests build their own. */
export const sessions = new SessionRegistry();
