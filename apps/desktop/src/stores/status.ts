/**
 * Status-line store (LOA-84, §3.5, D2). Index status from the vault +
 * `vault://index-progress` events; note counts computed off the keystroke
 * path (debounced); a cursor slot the E09 editor fills (shown only when
 * applicable). The right-aligned plugin item region renders from the
 * registration list (§3.11 shape, empty until the plugin platform).
 */

import type { IndexStatus, IpcTransport, Unsubscribe } from "@loam-app/ipc-client";
import type { ReactNode } from "react";
import { create } from "zustand";

export interface StatusCounts {
  words: number;
  characters: number;
}

export interface StatusPluginItem {
  id: string;
  render: () => ReactNode;
}

export interface StatusState {
  indexStatus: IndexStatus;
  /** During (re)indexing: `{done,total}` from the event stream. */
  indexProgress: { done: number; total: number } | null;
  counts: StatusCounts | null;
  /** Filled by the E09 editor in Source mode; null hides the item (AC3). */
  cursor: { line: number; ch: number } | null;
  countDisplay: "words" | "characters";
  pluginItems: StatusPluginItem[];
  /** Zen mode (future command) hides the whole bar. */
  hidden: boolean;
  start(transport: IpcTransport, vaultId: string, initial: IndexStatus): Promise<Unsubscribe>;
  setNoteContent(content: string | null): void;
  setCursor(cursor: { line: number; ch: number } | null): void;
  toggleCountDisplay(): void;
  registerPluginItem(item: StatusPluginItem): void;
  setHidden(hidden: boolean): void;
}

/** Word/char counting, kept off the keystroke path by the debounce below. */
export function countText(content: string): StatusCounts {
  const words = content.split(/\s+/).filter(Boolean).length;
  return { words, characters: content.length };
}

const COUNT_DEBOUNCE_MS = 150;

export function createStatusStore() {
  let countTimer: ReturnType<typeof setTimeout> | null = null;

  return create<StatusState>()((set, get) => ({
    indexStatus: "notIndexed",
    indexProgress: null,
    counts: null,
    cursor: null,
    countDisplay: "words",
    pluginItems: [],
    hidden: false,

    async start(transport, vaultId, initial) {
      set({ indexStatus: initial, indexProgress: null });
      return transport.listen<{ done: number; total: number }>(
        "vault://index-progress",
        (envelope) => {
          if (envelope.vaultId !== vaultId) return; // defense-in-depth (§5.4)
          const { done, total } = envelope.payload;
          set(
            done >= total
              ? { indexStatus: "ready", indexProgress: null }
              : { indexStatus: "indexing", indexProgress: { done, total } },
          );
        },
      );
    },

    setNoteContent(content) {
      if (countTimer) clearTimeout(countTimer);
      if (content === null) {
        set({ counts: null });
        return;
      }
      // AC2: debounced — typing never waits on counting.
      countTimer = setTimeout(() => {
        set({ counts: countText(content) });
      }, COUNT_DEBOUNCE_MS);
    },
    setCursor(cursor) {
      set({ cursor });
    },
    toggleCountDisplay() {
      set((state) => ({
        countDisplay: state.countDisplay === "words" ? "characters" : "words",
      }));
    },
    registerPluginItem(item) {
      if (get().pluginItems.some((candidate) => candidate.id === item.id)) return;
      set((state) => ({ pluginItems: [...state.pluginItems, item] }));
    },
    setHidden(hidden) {
      set({ hidden });
    },
  }));
}

export type StatusStore = ReturnType<typeof createStatusStore>;

/** Human text for the index glyph — never color/icon alone (AC4). */
export function indexStatusText(
  status: IndexStatus,
  progress: { done: number; total: number } | null,
): string {
  if (status === "ready") return "Index ready";
  if (status === "indexing") {
    return progress ? `Indexing ${progress.done}/${progress.total}` : "Indexing";
  }
  return "Not indexed";
}
