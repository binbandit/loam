/**
 * External-edit conflicts (LOA-89, §5.6, D2). Clean buffers reload
 * silently; dirty buffers get a non-blocking banner with three explicit
 * actions — a modal may never discard work. Resolutions carry the CURRENT
 * disk hash (stale resolutions surface the next conflict, never clobber).
 */

import type { ConflictPayload, IpcTransport, Unsubscribe } from "@loam-app/ipc-client";
import { create } from "zustand";

export interface ConflictsState {
  /** Open conflicts by note path. */
  conflicts: Record<string, ConflictPayload>;
  /** Per-path reload generation: clean buffers re-read when this bumps. */
  reloadGeneration: Record<string, number>;
  /** §4.5 resolution error line, per path. */
  errors: Record<string, string>;
  /** Paths currently showing the side-by-side merge surface. */
  merging: string | null;
  start(
    transport: IpcTransport,
    vaultId: string,
    isDirty: (path: string) => boolean,
  ): Promise<Unsubscribe>;
  /** Keep mine: write the buffer over disk, guarded by the disk hash. */
  keepMine(transport: IpcTransport, vaultId: string, path: string): Promise<void>;
  /** Take disk: drop the buffer and reload from disk. */
  takeDisk(path: string): void;
  openMerge(path: string): void;
  closeMerge(): void;
  dismiss(path: string): void;
}

export function createConflictsStore() {
  return create<ConflictsState>()((set, get) => {
    const bumpReload = (path: string): void => {
      set((state) => ({
        reloadGeneration: {
          ...state.reloadGeneration,
          [path]: (state.reloadGeneration[path] ?? 0) + 1,
        },
      }));
    };
    const clear = (path: string): void => {
      set((state) => {
        const conflicts = { ...state.conflicts };
        delete conflicts[path];
        const errors = { ...state.errors };
        delete errors[path];
        return { conflicts, errors, merging: state.merging === path ? null : state.merging };
      });
    };

    return {
      conflicts: {},
      reloadGeneration: {},
      errors: {},
      merging: null,

      async start(transport, vaultId, isDirty) {
        const subscriptions = await Promise.all([
          // Clean buffers: external modifications reload silently (§5.6).
          transport.listen<{ path: string; origin: string } & Record<string, unknown>>(
            "vault://file-changed",
            (envelope) => {
              if (envelope.vaultId !== vaultId) return;
              const { path, origin } = envelope.payload;
              if (origin !== "external") return;
              if (!isDirty(path)) bumpReload(path);
            },
          ),
          // Dirty buffers: the §5.6 conflict payload drives the banner.
          transport.listen<ConflictPayload>("vault://conflict", (envelope) => {
            if (envelope.vaultId !== vaultId) return;
            const payload = envelope.payload;
            set((state) => ({ conflicts: { ...state.conflicts, [payload.path]: payload } }));
          }),
        ]);
        return () => {
          for (const unsubscribe of subscriptions) unsubscribe();
        };
      },

      async keepMine(transport, vaultId, path) {
        const conflict = get().conflicts[path];
        if (!conflict) return;
        try {
          const commands = await transport.getCommands();
          // AC: the resolution carries the CURRENT disk hash — if disk moved
          // again, this returns `conflict` and the banner updates instead of
          // clobbering (§5.4).
          const result = await commands.noteWrite(vaultId, path, conflict.mine, conflict.diskHash);
          if (result.status === "error") {
            if (result.error.error === "conflict") {
              set((state) => ({
                errors: {
                  ...state.errors,
                  [path]: "The note changed on disk again. Review the newer version.",
                },
              }));
              return;
            }
            set((state) => ({
              errors: {
                ...state.errors,
                [path]: `Couldn't keep your version: ${result.error.error.replace(/-/g, " ")}`,
              },
            }));
            return;
          }
          clear(path);
          bumpReload(path);
        } catch (error) {
          set((state) => ({
            errors: {
              ...state.errors,
              [path]: `Couldn't keep your version: ${error instanceof Error ? error.message : String(error)}`,
            },
          }));
        }
      },

      takeDisk(path) {
        clear(path);
        bumpReload(path);
      },
      openMerge(path) {
        set({ merging: path });
      },
      closeMerge() {
        set({ merging: null });
      },
      dismiss(path) {
        clear(path);
      },
    };
  });
}

export type ConflictsStore = ReturnType<typeof createConflictsStore>;
