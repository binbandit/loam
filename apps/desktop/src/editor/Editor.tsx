/**
 * Framework-thin CM6 host (LOA-68, D3). React owns the container element
 * and nothing else: the `EditorView` is created once per mount, documents
 * arrive as pre-built states from the session registry, and read-only
 * changes go through a compartment reconfiguration — never a new state
 * (AC2/AC3). Switching notes swaps states, so each keeps its selection and
 * undo history (AC4).
 */

import type { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { setLivePreviewFamilies } from "./preview/engine";
import { CORE_FAMILIES } from "./preview/families";
import { readOnlyExtension, type SessionRegistry } from "./sessions";
import "./editor.css";

export interface EditorProps {
  registry: SessionRegistry;
  path: string;
  /** Source bytes as read from disk (`NoteDoc.content`). */
  doc: string;
  baseHash: string | null;
  readOnly?: boolean | undefined;
  /** §3.2 Live Preview; false renders plain Source (LOA-102). */
  livePreview?: boolean | undefined;
  /** Fires on document-changing updates only (LOA-69 wires save/dirty). */
  onDocChange?: ((content: string, state: EditorState) => void) | undefined;
  /** Fires on selection moves (status-bar cursor, LOA-84). */
  onSelectionChange?: ((line: number, column: number) => void) | undefined;
}

export function Editor({
  registry,
  path,
  doc,
  baseHash,
  readOnly = false,
  livePreview = true,
  onDocChange,
  onSelectionChange,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const mountedPath = useRef<string | null>(null);
  // Live props live in refs so changing any of them never rebuilds the
  // editor; the mount effect reads the values current at mount time.
  const handlers = useRef({ onDocChange, onSelectionChange });
  handlers.current = { onDocChange, onSelectionChange };
  const latest = useRef({ path, doc, baseHash, readOnly, livePreview });
  latest.current = { path, doc, baseHash, readOnly, livePreview };

  // Mount once. The view outlives every parent render.
  useEffect(() => {
    if (!host.current) return;
    const {
      path: at,
      doc: source,
      baseHash: hash,
      readOnly: locked,
      livePreview: preview,
    } = latest.current;
    const session = registry.open(at, source, hash, { readOnly: locked, livePreview: preview });
    const instance = new EditorView({
      state: session.state,
      parent: host.current,
      dispatch: (transaction, self) => {
        self.update([transaction]);
        // The registry is authoritative: every state lands there.
        registry.capture(mountedPath.current ?? at, self.state);
        if ((transaction as unknown as ViewUpdate).docChanged) {
          handlers.current.onDocChange?.(self.state.doc.toString(), self.state);
        }
        const head = self.state.selection.main.head;
        const line = self.state.doc.lineAt(head);
        handlers.current.onSelectionChange?.(line.number, head - line.from + 1);
      },
    });
    view.current = instance;
    mountedPath.current = at;
    registry.attach(at, instance);
    return () => {
      registry.detach(mountedPath.current ?? at, instance);
      registry.capture(mountedPath.current ?? at, instance.state);
      instance.destroy();
      view.current = null;
    };
    // Mount-only by design: path/doc changes are handled by the effect below.
  }, [registry]);

  // Switching notes: swap in the other session's state (AC4). Selection and
  // undo history ride along because they live in the state.
  useEffect(() => {
    const instance = view.current;
    if (!instance || mountedPath.current === path) return;
    if (mountedPath.current) {
      registry.capture(mountedPath.current, instance.state);
      registry.detach(mountedPath.current, instance);
    }
    const session = registry.open(path, doc, baseHash, { readOnly, livePreview });
    instance.setState(session.state);
    mountedPath.current = path;
    registry.attach(path, instance);
  }, [registry, path, doc, baseHash, readOnly, livePreview]);

  // Read-only toggles reconfigure in place — the document is untouched (AC3).
  useEffect(() => {
    const instance = view.current;
    const session = registry.get(path);
    if (!instance || !session) return;
    instance.dispatch({
      effects: session.compartments.readOnly.reconfigure(readOnlyExtension(readOnly)),
    });
  }, [registry, path, readOnly]);

  // Mode switches swap the enabled families in place — same state, same
  // history, and the document is never touched (LOA-95 AC1).
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    setLivePreviewFamilies(instance, livePreview ? CORE_FAMILIES : []);
  }, [livePreview, path]);

  return <div ref={host} className="loam-editor" data-testid="editor" data-path={path} />;
}
