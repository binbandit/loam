/**
 * File-tree domain store (LOA-72, D2). Loads the vault enumeration through
 * the transport's typed commands, derives the E07 Tree hierarchy, and owns
 * sort/expand/select/rename state. Mutations follow §4.5: inline,
 * cause-and-remedy errors, and rows only change after core success (AC5).
 */

import type { IpcTransport, LoamError, TreeEntryDto } from "@loam-app/ipc-client";
import { LoamIpcError } from "@loam-app/ipc-client";
import { create } from "zustand";
import { deviceStorage } from "./device-storage";

export type TreeSort = "name" | "modified";

export interface FilesState {
  entries: TreeEntryDto[];
  loading: boolean;
  sort: TreeSort;
  expanded: Set<string>;
  selected: Set<string>;
  renamingPath: string | null;
  /** §4.5 inline error line ("Couldn't rename: …"); null when healthy. */
  error: string | null;
  load(vaultId: string): Promise<void>;
  setSort(sort: TreeSort): void;
  setExpanded(expanded: Set<string>): void;
  setSelected(selected: Set<string>): void;
  startRename(path: string): void;
  cancelRename(): void;
  commitRename(vaultId: string, from: string, newName: string): Promise<void>;
  createNote(vaultId: string, folder: string): Promise<void>;
  createFolder(vaultId: string, parent: string): Promise<void>;
  duplicate(vaultId: string, path: string): Promise<void>;
  trash(vaultId: string, path: string): Promise<void>;
}

/** §4.5: cause first, remedy implied; kebab error tags become plain words. */
export function describeError(action: string, error: unknown): string {
  if (error instanceof LoamIpcError) {
    const detail = error.detail as LoamError;
    if (detail.error === "already-exists") {
      return `Couldn't ${action}: a file named '${lastSegment(detail.path)}' already exists`;
    }
    if (detail.error === "read-only") {
      return `Couldn't ${action}: the vault is read-only`;
    }
    return `Couldn't ${action}: ${detail.error.replace(/-/g, " ")}`;
  }
  return `Couldn't ${action}: ${error instanceof Error ? error.message : String(error)}`;
}

function lastSegment(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function storageKey(vaultId: string): string {
  return `loam.tree.${vaultId}`;
}

/* localStorage with an in-memory fallback: blocked/absent storage (privacy
 * modes, some test environments) degrades to session-only persistence. The
 * real per-device home is workspace.json (LOA-91). */

/** Device-local collapse + sort persistence (AC4; migrates into LOA-91). */
export function readPersisted(vaultId: string): { expanded: string[]; sort: TreeSort } | null {
  try {
    const raw = deviceStorage().getItem(storageKey(vaultId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persist(vaultId: string, expanded: Set<string>, sort: TreeSort): void {
  try {
    deviceStorage().setItem(storageKey(vaultId), JSON.stringify({ expanded: [...expanded], sort }));
  } catch {
    // Storage full: collapse state is a nicety, never an error.
  }
}

export function createFilesStore(transport: IpcTransport) {
  let currentVaultId: string | null = null;

  return create<FilesState>()((set, get) => {
    const refresh = async (vaultId: string): Promise<void> => {
      const commands = await transport.getCommands();
      const result = await commands.vaultTree(vaultId);
      if (result.status === "error") throw new LoamIpcError(result.error);
      set({ entries: result.data.entries });
    };

    /** Runs a mutation; the tree only changes when core succeeded (AC5). */
    const mutate = async (
      vaultId: string,
      action: string,
      run: (
        commands: Awaited<ReturnType<IpcTransport["getCommands"]>>,
      ) => Promise<{ status: "ok"; data: unknown } | { status: "error"; error: LoamError }>,
    ): Promise<void> => {
      set({ error: null });
      try {
        const commands = await transport.getCommands();
        const result = await run(commands);
        if (result.status === "error") throw new LoamIpcError(result.error);
        await refresh(vaultId);
      } catch (error) {
        // AC3: failures leave entries/expanded/selection untouched.
        set({ error: describeError(action, error) });
      }
    };

    return {
      entries: [],
      loading: false,
      sort: "name",
      expanded: new Set<string>(),
      selected: new Set<string>(),
      renamingPath: null,
      error: null,

      async load(vaultId) {
        currentVaultId = vaultId;
        const persisted = readPersisted(vaultId);
        set({
          loading: true,
          error: null,
          expanded: new Set(persisted?.expanded ?? []),
          sort: persisted?.sort ?? "name",
        });
        try {
          await refresh(vaultId);
        } catch (error) {
          set({ error: describeError("load the vault", error) });
        } finally {
          set({ loading: false });
        }
      },

      setSort(sort) {
        set({ sort });
        if (currentVaultId) persist(currentVaultId, get().expanded, sort);
      },
      setExpanded(expanded) {
        set({ expanded });
        if (currentVaultId) persist(currentVaultId, expanded, get().sort);
      },
      setSelected(selected) {
        set({ selected });
      },
      startRename(path) {
        set({ renamingPath: path, error: null });
      },
      cancelRename() {
        set({ renamingPath: null });
      },

      async commitRename(vaultId, from, newName) {
        const parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
        const to = parent ? `${parent}/${newName}` : newName;
        if (to === from) {
          set({ renamingPath: null });
          return;
        }
        await mutate(vaultId, "rename", (commands) => commands.noteRename(vaultId, from, to));
        if (get().error === null) set({ renamingPath: null });
      },
      createNote(vaultId, folder) {
        return mutate(vaultId, "create the note", (commands) =>
          commands.noteCreate(vaultId, folder, "Untitled"),
        );
      },
      createFolder(vaultId, parent) {
        return mutate(vaultId, "create the folder", (commands) =>
          commands.folderCreate(vaultId, parent, "New folder"),
        );
      },
      duplicate(vaultId, path) {
        return mutate(vaultId, "duplicate", (commands) => commands.noteDuplicate(vaultId, path));
      },
      trash(vaultId, path) {
        return mutate(vaultId, "move to trash", (commands) => commands.noteTrash(vaultId, path));
      },
    };
  });
}

export type FilesStore = ReturnType<typeof createFilesStore>;

/** Typed selectors (D2). */
export const selectEntries = (state: FilesState): TreeEntryDto[] => state.entries;
export const selectTreeError = (state: FilesState): string | null => state.error;
export const selectSort = (state: FilesState): TreeSort => state.sort;
