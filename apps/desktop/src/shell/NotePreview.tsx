/**
 * Read-only note preview for the active tab (LOA-75). A stopgap surface —
 * the CM6 editor session (E09) replaces the body while keeping this file's
 * data flow (note_read through the transport).
 */

import type { NoteDoc, VaultInfo } from "@loam-app/ipc-client";
import { LoamIpcError } from "@loam-app/ipc-client";
import { useEffect, useState } from "react";
import { ipc } from "../ipc";
import { describeError } from "../stores/files";
import "./shell.css";

export interface NotePreviewProps {
  vault: VaultInfo;
  path: string;
  /** Reports loaded content upward (status counts, LOA-84). */
  onContent?: ((content: string | null) => void) | undefined;
  /** Bumps when the note must re-read (silent clean reload, §5.6). */
  reloadGeneration?: number | undefined;
}

export function NotePreview({ vault, path, onContent, reloadGeneration }: NotePreviewProps) {
  const [doc, setDoc] = useState<NoteDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // `reloadGeneration` re-runs this read after silent §5.6 disk reloads.
    void reloadGeneration;
    let cancelled = false;
    (async () => {
      try {
        const commands = await ipc.getCommands();
        const result = await commands.noteRead(vault.id, path);
        if (result.status === "error") throw new LoamIpcError(result.error);
        if (!cancelled) {
          setDoc(result.data);
          onContent?.(result.data.content);
        }
      } catch (caught) {
        if (!cancelled) setError(describeError("open the note", caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vault.id, path, onContent, reloadGeneration]);

  if (error) {
    return (
      <p className="shell__placeholder" role="alert" data-testid="note-preview-error">
        {error}
      </p>
    );
  }
  return (
    <pre className="note-preview" data-testid="note-preview">
      {doc?.content ?? ""}
    </pre>
  );
}
