/**
 * The note surface for a pane (LOA-68). Loads `NoteDoc` through the
 * transport and hands its exact source bytes to the CM6 editor; the editor
 * session (selection, undo history) lives in the registry keyed by path.
 * Save and dirty tracking arrive with LOA-69.
 */

import type { NoteDoc, NoteMeta, VaultInfo } from "@loam-app/ipc-client";
import { LoamIpcError } from "@loam-app/ipc-client";
import { useEffect, useState } from "react";
import { Editor } from "../editor/Editor";
import { isEditable } from "../editor/policy";
import { sessions } from "../editor/sessions";
import { ipc } from "../ipc";
import { describeError } from "../stores/files";
import type { FindStore } from "../stores/find";
import type { SavesStore } from "../stores/saves";
import { FindPanel } from "./FindPanel";
import "./shell.css";

export interface NoteViewProps {
  vault: VaultInfo;
  path: string;
  /** Reports loaded content upward (status counts, LOA-84). */
  onContent?: ((content: string | null) => void) | undefined;
  /** Bumps when the note must re-read (silent clean reload, §5.6). */
  reloadGeneration?: number | undefined;
  /** Active-pane cursor reporting (status bar, LOA-84). */
  onCursor?: ((line: number, column: number) => void) | undefined;
  /** Reports the §5.6 size classification upward (LOA-88). */
  onMeta?: ((path: string, meta: NoteMeta) => void) | undefined;
  savesStore: SavesStore;
  findStore: FindStore;
}

export function NoteView({
  vault,
  path,
  onContent,
  reloadGeneration,
  onCursor,
  onMeta,
  savesStore,
  findStore,
}: NoteViewProps) {
  const [doc, setDoc] = useState<NoteDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const findOpen = findStore((state) => state.openFor === path);
  const withReplace = findStore((state) => state.withReplace);
  const revision = findStore((state) => state.revision);

  useEffect(() => {
    // `reloadGeneration` re-runs this read after silent §5.6 disk reloads.
    void reloadGeneration;
    let cancelled = false;
    (async () => {
      try {
        const commands = await ipc.getCommands();
        const result = await commands.noteRead(vault.id, path);
        if (result.status === "error") throw new LoamIpcError(result.error);
        if (cancelled) return;
        const fresh = result.data;
        // Disk moved under a clean buffer (§5.6 silent reload): drop the
        // stale session so the editor rebuilds from the on-disk bytes.
        const session = sessions.get(path);
        if (session && session.baseHash !== fresh.hash) sessions.close(path);
        setDoc(fresh);
        setError(null);
        onContent?.(fresh.content);
        onMeta?.(path, fresh.meta);
        // A note past 20 MB is never read into memory (§5.6), so there is no
        // buffer to save — registering one would let a write truncate it.
        if (!isEditable(fresh.meta)) return;
        // Base hash for every subsequent write (§5.4).
        savesStore.getState().register(vault.id, path, fresh.content ?? "", fresh.hash);
      } catch (caught) {
        if (!cancelled) setError(describeError("open the note", caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vault.id, path, onContent, onMeta, reloadGeneration, savesStore]);

  if (error) {
    return (
      <p className="shell__placeholder" role="alert" data-testid="note-error">
        {error}
      </p>
    );
  }
  if (!doc) return <p className="shell__placeholder">Opening…</p>;

  return (
    <>
      {findOpen ? (
        <FindPanel
          registry={sessions}
          path={path}
          withReplace={withReplace}
          revision={revision}
          onClose={() => findStore.getState().close()}
        />
      ) : null}
      <Editor
        // Keyed to the bytes it was built from: a reload with different
        // content remounts against the fresh session (§5.6).
        key={`${path}:${doc.hash}`}
        registry={sessions}
        path={path}
        doc={doc.content ?? ""}
        baseHash={doc.hash}
        // AC4: editable unless the file is read-only — or too large to read.
        readOnly={!isEditable(doc.meta)}
        onDocChange={(content) => {
          savesStore.getState().edited(path, content);
          findStore.getState().bumpRevision();
        }}
        onSelectionChange={onCursor}
      />
    </>
  );
}
