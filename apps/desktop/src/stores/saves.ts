/**
 * Note save + dirty-state flow (LOA-69, §5.4/§5.6, D2). Every write carries
 * the base hash the buffer was read at; the hash advances only on success,
 * so a stale write returns `conflict` and the buffer stays dirty — content
 * is never silently lost.
 *
 * Autosave is a trailing debounce scheduled off the keystroke path; an
 * explicit save (⌘S) flushes immediately. Edits landing while a write is
 * in flight set a `pending` flag so the newest content is saved right
 * after (AC4).
 */

import type { IpcTransport, LoamError } from "@loam-app/ipc-client";
import { create } from "zustand";

export type SaveStatus = "clean" | "dirty" | "saving" | "conflict" | "error";

export interface SaveEntry {
  /** Vault the note belongs to (writes are per vault). */
  vaultId: string;
  status: SaveStatus;
  /** Hash the buffer is based on; advances only on a successful write. */
  baseHash: string | null;
  /** Newest editor content, always what a save writes. */
  content: string;
  /** Disk hash reported by a conflicting write (§5.6). */
  conflictHash: string | null;
  error: string | null;
}

export interface SavesState {
  entries: Record<string, SaveEntry>;
  autosaveMs: number;
  /** Seed a session from `note_read` (clean, based on the read hash). */
  register(vaultId: string, path: string, content: string, baseHash: string | null): void;
  /** Editor reported new content: mark dirty and schedule autosave. */
  edited(path: string, content: string): void;
  /** ⌘S / blur: flush now, bypassing the debounce. */
  saveNow(path: string): Promise<void>;
  /** Drop tracking (tab closed). */
  forget(path: string): void;
  setAutosaveMs(ms: number): void;
  isDirty(path: string): boolean;
  /** Test seam: pending debounce for a path? */
  hasScheduledSave(path: string): boolean;
}

export interface SavesOptions {
  /** Tab/pane dirty indicators (LOA-75). */
  onDirtyChange?: (path: string, dirty: boolean) => void;
  /** Successful write: the session's base hash advanced. */
  onSaved?: (path: string, hash: string) => void;
  autosaveMs?: number;
}

function describeSaveError(error: LoamError): string {
  if (error.error === "read-only") return "Couldn't save: the vault is read-only";
  if (error.error === "not-found") return "Couldn't save: the note no longer exists on disk";
  return `Couldn't save: ${error.error.replace(/-/g, " ")}`;
}

export function createSavesStore(transport: IpcTransport, options: SavesOptions = {}) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  const pending = new Set<string>();

  return create<SavesState>()((set, get) => {
    const patch = (path: string, changes: Partial<SaveEntry>): void => {
      set((state) => {
        const entry = state.entries[path];
        if (!entry) return state;
        return { entries: { ...state.entries, [path]: { ...entry, ...changes } } };
      });
    };

    const write = async (path: string): Promise<void> => {
      const entry = get().entries[path];
      if (!entry) return;
      if (inFlight.has(path)) {
        // AC4: a write is already going; remember to save the newest after.
        pending.add(path);
        return;
      }
      inFlight.add(path);
      const attempted = entry.content;
      patch(path, { status: "saving", error: null });
      try {
        const commands = await transport.getCommands();
        const result = await commands.noteWrite(entry.vaultId, path, attempted, entry.baseHash);
        if (result.status === "error") {
          if (result.error.error === "conflict") {
            // §5.6: keep the buffer dirty; the banner drives resolution.
            patch(path, {
              status: "conflict",
              conflictHash: result.error.diskHash,
              error: "This note changed on disk. Resolve the conflict to save.",
            });
          } else {
            patch(path, { status: "error", error: describeSaveError(result.error) });
          }
          return;
        }
        // Success: advance the base hash. Content typed while the write was
        // in flight keeps the buffer dirty (handled by the pending pass).
        const current = get().entries[path];
        const stillMatches = current?.content === attempted;
        patch(path, {
          baseHash: result.data.hash,
          status: stillMatches ? "clean" : "dirty",
          conflictHash: null,
          error: null,
        });
        options.onSaved?.(path, result.data.hash);
        if (stillMatches) options.onDirtyChange?.(path, false);
      } catch (error) {
        patch(path, {
          status: "error",
          error: `Couldn't save: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        inFlight.delete(path);
        if (pending.delete(path)) await write(path);
      }
    };

    const schedule = (path: string): void => {
      const existing = timers.get(path);
      if (existing) clearTimeout(existing);
      timers.set(
        path,
        setTimeout(() => {
          timers.delete(path);
          void write(path);
        }, get().autosaveMs),
      );
    };

    return {
      entries: {},
      autosaveMs: options.autosaveMs ?? 800,

      register(vaultId, path, content, baseHash) {
        // AC5: a re-read (tab switch, remount) must never overwrite an
        // unsaved buffer — nor its base hash, which a stale write needs to
        // conflict against rather than clobber (§5.6).
        const existing = get().entries[path];
        if (existing && existing.status !== "clean") return;
        set((state) => ({
          entries: {
            ...state.entries,
            [path]: {
              vaultId,
              status: "clean",
              baseHash,
              content,
              conflictHash: null,
              error: null,
            },
          },
        }));
      },

      edited(path, content) {
        const entry = get().entries[path];
        if (!entry) return;
        const dirty = content !== entry.content || entry.status !== "clean";
        patch(path, {
          content,
          // A conflicted buffer stays conflicted until it is resolved.
          status: entry.status === "conflict" ? "conflict" : "dirty",
        });
        if (dirty) options.onDirtyChange?.(path, true);
        schedule(path);
      },

      async saveNow(path) {
        const timer = timers.get(path);
        if (timer) {
          clearTimeout(timer);
          timers.delete(path);
        }
        await write(path);
      },

      forget(path) {
        const timer = timers.get(path);
        if (timer) clearTimeout(timer);
        timers.delete(path);
        pending.delete(path);
        set((state) => {
          const entries = { ...state.entries };
          delete entries[path];
          return { entries };
        });
      },

      setAutosaveMs(ms) {
        set({ autosaveMs: ms });
      },
      isDirty(path) {
        const status = get().entries[path]?.status;
        return status === "dirty" || status === "conflict" || status === "saving";
      },
      hasScheduledSave(path) {
        return timers.has(path);
      },
    };
  });
}

export type SavesStore = ReturnType<typeof createSavesStore>;

/** Typed selectors (D2). */
export const selectSaveEntry =
  (path: string) =>
  (state: SavesState): SaveEntry | undefined =>
    state.entries[path];
