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
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
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
import { editorAnnouncements } from "./announce";
import { foldingKeymap, markdownFolding, selectionKeymap } from "./folding";
import { formattingKeymap, pasteLink, smartPairs } from "./formatting";
import { listKeymap } from "./lists";
import { livePreview, livePreviewCompartment } from "./preview/engine";
import { CORE_FAMILIES } from "./preview/families";
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
  /** §3.2 default mode; false opens the note in plain Source (LOA-102). */
  livePreview?: boolean;
  /** Extra extensions (find/replace, formatting, … land in later stories). */
  extensions?: Extension[];
}

/** One named slice of the Source-mode stack; the perf profile costs these. */
export interface ExtensionLayer {
  name: string;
  description: string;
  extensions: Extension[];
}

/**
 * The Source-mode stack, in application order, split into the layers the
 * LOA-90 profile reports. This list is the single source of truth: the
 * benchmark measures the real stack, never a copy that can drift.
 */
export function extensionLayers(options: { livePreview?: boolean } = {}): ExtensionLayer[] {
  const families = options.livePreview === false ? [] : CORE_FAMILIES;
  return [
    {
      name: "core",
      description: "history, selection drawing, active line, bracket matching, wrapping",
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        highlightActiveLine(),
        indentOnInput(),
        bracketMatching(),
        EditorState.allowMultipleSelections.of(true),
        EditorView.lineWrapping,
      ],
    },
    {
      name: "search",
      // Matching only — Loam renders its own panel (LOA-74, §4.3).
      description: "CM6 search state, highlight-all, selection matches",
      extensions: [search({ literal: true }), highlightAllMatches, highlightSelectionMatches()],
    },
    {
      name: "markdown",
      // §3.3 dialect is CommonMark + GFM; the GFM base is what gives the
      // parser strikethrough, tables, and task-list nodes.
      description: "Lezer Markdown (GFM) parsing and highlighting",
      extensions: [markdown({ base: markdownLanguage })],
    },
    {
      name: "editing",
      description: "smart pairs and paste-as-link (LOA-79)",
      extensions: [smartPairs(), pasteLink()],
    },
    {
      name: "folding",
      description: "heading/list folds, fold gutter, ⌘-click multicursor (LOA-85)",
      extensions: [markdownFolding()],
    },
    {
      name: "announcements",
      description: "§4.6 live-region announcements (LOA-90)",
      extensions: [editorAnnouncements],
    },
    {
      name: "preview",
      description: "Live Preview families: headings and inline emphasis (LOA-95/LOA-102)",
      // Compartmented so a tab's mode flips families without recreating the
      // state; with none enabled this draws nothing and the editor is Source.
      extensions: [livePreviewCompartment.of(livePreview(families))],
    },
    {
      name: "keymap",
      // List bindings come first: Enter/Tab fall through to the defaults
      // when the cursor is not in a list.
      description: "list, formatting, selection, fold, default, and history bindings",
      extensions: [
        keymap.of([
          ...listKeymap,
          ...formattingKeymap,
          ...selectionKeymap,
          ...foldingKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
      ],
    },
  ];
}

/** The editing stack; `livePreview: false` is plain Source mode (§3.2). */
export function sourceExtensions(options: { livePreview?: boolean } = {}): Extension[] {
  return extensionLayers(options).flatMap((layer) => layer.extensions);
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
        sourceExtensions({ livePreview: options.livePreview ?? true }),
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
