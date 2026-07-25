/**
 * Find/replace panel state (LOA-74, D2). Which note has the panel open,
 * whether the replace row is showing, and a revision counter the panel
 * watches so its match count follows document edits (AC2).
 */

import { create } from "zustand";

export interface FindState {
  openFor: string | null;
  withReplace: boolean;
  /** Bumped on every document change in the active editor. */
  revision: number;
  open(path: string, withReplace: boolean): void;
  close(): void;
  bumpRevision(): void;
}

export function createFindStore() {
  return create<FindState>()((set) => ({
    openFor: null,
    withReplace: false,
    revision: 0,
    open(path, withReplace) {
      set((state) => ({
        openFor: path,
        withReplace,
        // Re-open re-seeds the panel (selection → query).
        revision: state.revision + 1,
      }));
    },
    close() {
      set({ openFor: null, withReplace: false });
    },
    bumpRevision() {
      set((state) => ({ revision: state.revision + 1 }));
    },
  }));
}

export type FindStore = ReturnType<typeof createFindStore>;
