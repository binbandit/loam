/**
 * Right-panel store (LOA-80, D2): view registration, active view, geometry,
 * and the generation-guarded active-note data boundary. Backlink CONTENT is
 * E11's (`backlinks(path) -> Vec<Mention>` once the links engine lands);
 * this store owns the request lifecycle so stale responses can never
 * overwrite newer-note content (AC3).
 */

import type { ReactNode } from "react";
import { create } from "zustand";
import { deviceStorage } from "./device-storage";

/** The `registerView` shape plugin views reuse later (§3.11). */
export interface PanelViewRegistration {
  id: string;
  title: string;
  /** Renders with the active-note context; data flows through the store. */
  render: (context: PanelViewContext) => ReactNode;
}

export interface PanelViewContext {
  vaultId: string;
  activeNotePath: string | null;
}

export interface PanelState {
  views: PanelViewRegistration[];
  activeViewId: string;
  width: number;
  collapsed: boolean;
  /** Monotonic request generation for the active note (AC2/AC3). */
  generation: number;
  activeNotePath: string | null;
  registerView(view: PanelViewRegistration): void;
  setActiveView(id: string): void;
  setWidth(width: number): void;
  toggle(): void;
  /** New active note: bumps the generation; stale replies check it. */
  setActiveNote(path: string | null): number;
  /** True only when `generation` is still current (guards async replies). */
  isCurrent(generation: number): boolean;
  load(vaultId: string): void;
}

interface PersistedPanel {
  width: number;
  collapsed: boolean;
  activeViewId: string;
}

function panelKey(vaultId: string): string {
  return `loam.panel.${vaultId}`;
}

export function createPanelStore(builtinViews: PanelViewRegistration[]) {
  let vaultId: string | null = null;

  return create<PanelState>()((set, get) => {
    const save = (): void => {
      if (!vaultId) return;
      const { width, collapsed, activeViewId } = get();
      try {
        deviceStorage().setItem(
          panelKey(vaultId),
          JSON.stringify({ width, collapsed, activeViewId }),
        );
      } catch {
        // Panel geometry is a nicety, never an error.
      }
    };

    return {
      views: builtinViews,
      activeViewId: builtinViews[0]?.id ?? "",
      width: 280,
      collapsed: true,
      generation: 0,
      activeNotePath: null,

      registerView(view) {
        if (get().views.some((candidate) => candidate.id === view.id)) return;
        set((state) => ({ views: [...state.views, view] }));
      },
      setActiveView(id) {
        if (!get().views.some((view) => view.id === id)) return;
        set({ activeViewId: id });
        save();
      },
      setWidth(width) {
        set({ width });
        save();
      },
      toggle() {
        set((state) => ({ collapsed: !state.collapsed }));
        save();
      },
      setActiveNote(path) {
        if (path === get().activeNotePath) return get().generation;
        const generation = get().generation + 1;
        set({ activeNotePath: path, generation });
        return generation;
      },
      isCurrent(generation) {
        return generation === get().generation;
      },

      load(id) {
        vaultId = id;
        try {
          const raw = deviceStorage().getItem(panelKey(id));
          if (!raw) return;
          const parsed = JSON.parse(raw) as Partial<PersistedPanel>;
          set({
            width: typeof parsed.width === "number" ? parsed.width : 280,
            collapsed: parsed.collapsed === true,
            activeViewId: get().views.some((view) => view.id === parsed.activeViewId)
              ? (parsed.activeViewId as string)
              : get().activeViewId,
          });
        } catch {
          // Corrupt panel state: defaults win.
        }
      },
    };
  });
}

export type PanelStore = ReturnType<typeof createPanelStore>;

/** Typed selectors (D2). */
export const selectPanelViews = (state: PanelState): PanelViewRegistration[] => state.views;
export const selectPanelCollapsed = (state: PanelState): boolean => state.collapsed;
