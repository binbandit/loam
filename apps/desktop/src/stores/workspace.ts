/**
 * Workspace UI store (LOA-66, D2). Device-local chrome state: sidebar and
 * right-panel geometry. Tabs, panes, and persistence grow here through
 * LOA-75/76/91.
 */

import { create } from "zustand";

export interface WorkspaceState {
  leftSidebar: { width: number; collapsed: boolean };
  rightPanel: { width: number; collapsed: boolean };
  setLeftSidebarWidth(width: number): void;
  toggleLeftSidebar(): void;
  setRightPanelWidth(width: number): void;
  toggleRightPanel(): void;
}

export function createWorkspaceStore() {
  return create<WorkspaceState>()((set) => ({
    leftSidebar: { width: 240, collapsed: false },
    rightPanel: { width: 280, collapsed: true },
    setLeftSidebarWidth: (width) =>
      set((state) => ({ leftSidebar: { ...state.leftSidebar, width } })),
    toggleLeftSidebar: () =>
      set((state) => ({
        leftSidebar: { ...state.leftSidebar, collapsed: !state.leftSidebar.collapsed },
      })),
    setRightPanelWidth: (width) => set((state) => ({ rightPanel: { ...state.rightPanel, width } })),
    toggleRightPanel: () =>
      set((state) => ({
        rightPanel: { ...state.rightPanel, collapsed: !state.rightPanel.collapsed },
      })),
  }));
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;

/** Typed selectors (D2). */
export const selectLeftSidebar = (state: WorkspaceState): WorkspaceState["leftSidebar"] =>
  state.leftSidebar;
export const selectRightPanel = (state: WorkspaceState): WorkspaceState["rightPanel"] =>
  state.rightPanel;
