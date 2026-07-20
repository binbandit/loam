/**
 * Nested pane layout (LOA-76, §3.5, D2). A recursive tree of splits and
 * panes; every pane hosts its own tab strip (LOA-75 semantics per pane).
 * The tree invariant — splits always have exactly two children and empty
 * non-root panes collapse into their sibling — is enforced by the pure
 * reducers below (AC1) and unit-tested directly.
 *
 * Layout is device-local view state (persisted like the tree's collapse
 * state; the workspace.json home arrives with LOA-91). Corrupt or stale
 * persisted layout falls back to a single empty pane — notes on disk are
 * never touched by layout state (AC5).
 */

import { create } from "zustand";
import { deviceStorage } from "./device-storage";
import type { Tab } from "./tabs";

export type SplitDirection = "row" | "column";

/** One §3.5 history entry; `cursor` is the E09 jump-metadata slot. */
export interface NavEntry {
  path: string;
  cursor: { line: number; ch: number } | null;
}

export interface PaneLeaf {
  kind: "pane";
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
  /** Per-pane back/forward history (LOA-78): entries + current index. */
  history: { entries: NavEntry[]; index: number };
}

export interface PaneSplit {
  kind: "split";
  id: string;
  direction: SplitDirection;
  /** First-child size in px (E07 SplitPane, clamped there too). */
  size: number;
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

let nodeCounter = 0;
function nextId(prefix: "pane" | "split"): string {
  nodeCounter += 1;
  return `${prefix}-${nodeCounter}`;
}

export function emptyPane(): PaneLeaf {
  return {
    kind: "pane",
    id: nextId("pane"),
    tabs: [],
    activeTabId: null,
    history: { entries: [], index: -1 },
  };
}

// ─── Pure tree reducers (AC1) ───────────────────────────────────────────────

export function findPane(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.kind === "pane") return node.id === paneId ? node : null;
  return findPane(node.first, paneId) ?? findPane(node.second, paneId);
}

export function firstPane(node: PaneNode): PaneLeaf {
  return node.kind === "pane" ? node : firstPane(node.first);
}

export function allPanes(node: PaneNode): PaneLeaf[] {
  if (node.kind === "pane") return [node];
  return [...allPanes(node.first), ...allPanes(node.second)];
}

/** Replaces a pane by id; structural sharing elsewhere. */
export function replacePane(node: PaneNode, paneId: string, next: PaneNode): PaneNode {
  if (node.kind === "pane") return node.id === paneId ? next : node;
  const first = replacePane(node.first, paneId, next);
  const second = replacePane(node.second, paneId, next);
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

/** Splits `paneId`, keeping its content in the first slot. */
export function splitPaneNode(
  node: PaneNode,
  paneId: string,
  direction: SplitDirection,
  fresh: PaneLeaf,
  size: number,
): PaneNode {
  const target = findPane(node, paneId);
  if (!target) return node;
  const split: PaneSplit = {
    kind: "split",
    id: nextId("split"),
    direction,
    size,
    first: target,
    second: fresh,
  };
  return replacePane(node, paneId, split);
}

/** Removes an empty pane; its sibling takes the split's slot (AC1). */
export function collapseEmpty(node: PaneNode): PaneNode {
  if (node.kind === "pane") return node;
  const first = collapseEmpty(node.first);
  const second = collapseEmpty(node.second);
  const firstEmpty = first.kind === "pane" && first.tabs.length === 0;
  const secondEmpty = second.kind === "pane" && second.tabs.length === 0;
  if (firstEmpty && !secondEmpty) return second;
  if (secondEmpty && !firstEmpty) return first;
  if (firstEmpty && secondEmpty) return first; // both empty: keep one pane
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

/** Structural validity: splits binary, ids unique, panes well-formed. */
export function isValidTree(node: unknown, seen = new Set<string>()): node is PaneNode {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as Record<string, unknown>;
  if (typeof candidate.id !== "string" || seen.has(candidate.id)) return false;
  seen.add(candidate.id);
  if (candidate.kind === "pane") {
    return Array.isArray(candidate.tabs);
  }
  if (candidate.kind === "split") {
    return (
      (candidate.direction === "row" || candidate.direction === "column") &&
      typeof candidate.size === "number" &&
      isValidTree(candidate.first, seen) &&
      isValidTree(candidate.second, seen)
    );
  }
  return false;
}

// ─── Persistence (device-local; LOA-91 moves this into workspace.json) ──────

interface PersistedPane {
  kind: "pane";
  paths: string[];
  activePath: string | null;
}
interface PersistedSplit {
  kind: "split";
  direction: SplitDirection;
  size: number;
  first: PersistedNode;
  second: PersistedNode;
}
type PersistedNode = PersistedPane | PersistedSplit;

function serialize(node: PaneNode): PersistedNode {
  if (node.kind === "pane") {
    return {
      kind: "pane",
      paths: node.tabs.map((tab) => tab.path),
      activePath: node.tabs.find((tab) => tab.id === node.activeTabId)?.path ?? null,
    };
  }
  return {
    kind: "split",
    direction: node.direction,
    size: node.size,
    first: serialize(node.first),
    second: serialize(node.second),
  };
}

let tabCounter = 0;
function makeTab(path: string): Tab {
  tabCounter += 1;
  return {
    id: `tab-${tabCounter}`,
    path,
    title: (path.split("/").at(-1) ?? path).replace(/\.md$/i, ""),
    viewMode: "source",
    dirty: false,
    missing: false,
  };
}

/** Rebuilds the tree, dropping notes that no longer exist (AC5). */
function revive(node: PersistedNode, validPaths: ReadonlySet<string>): PaneNode {
  if (node.kind === "pane") {
    const tabs = node.paths.filter((path) => validPaths.has(path)).map(makeTab);
    const active = tabs.find((tab) => tab.path === node.activePath) ?? tabs.at(-1) ?? null;
    return {
      kind: "pane",
      id: nextId("pane"),
      tabs,
      activeTabId: active?.id ?? null,
      history: active
        ? { entries: [{ path: active.path, cursor: null }], index: 0 }
        : { entries: [], index: -1 },
    };
  }
  return {
    kind: "split",
    id: nextId("split"),
    direction: node.direction,
    size: node.size,
    first: revive(node.first, validPaths),
    second: revive(node.second, validPaths),
  };
}

function isPersistedNode(node: unknown): node is PersistedNode {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as Record<string, unknown>;
  if (candidate.kind === "pane") return Array.isArray(candidate.paths);
  if (candidate.kind === "split") {
    return (
      (candidate.direction === "row" || candidate.direction === "column") &&
      typeof candidate.size === "number" &&
      isPersistedNode(candidate.first) &&
      isPersistedNode(candidate.second)
    );
  }
  return false;
}

function layoutKey(vaultId: string): string {
  return `loam.layout.${vaultId}`;
}

export function persistLayout(vaultId: string, root: PaneNode): void {
  try {
    deviceStorage().setItem(
      layoutKey(vaultId),
      JSON.stringify({ version: 1, root: serialize(root) }),
    );
  } catch {
    // Layout persistence is a nicety, never an error.
  }
}

/** AC5: anything unparseable or structurally wrong → one empty pane. */
export function restoreLayout(vaultId: string, validPaths: ReadonlySet<string>): PaneNode {
  try {
    const raw = deviceStorage().getItem(layoutKey(vaultId));
    if (!raw) return emptyPane();
    const parsed = JSON.parse(raw) as { version?: number; root?: unknown };
    if (parsed.version !== 1 || !isPersistedNode(parsed.root)) return emptyPane();
    return collapseEmpty(revive(parsed.root, validPaths));
  } catch {
    return emptyPane();
  }
}

// ─── Store ──────────────────────────────────────────────────────────────────

export interface ClosedTabEntry {
  path: string;
  paneId: string;
}

export interface PanesState {
  root: PaneNode;
  activePaneId: string;
  closedStack: ClosedTabEntry[];
  pendingClose: { paneId: string; tab: Tab } | null;
  /** Load persisted layout for a vault (AC4/AC5). */
  load(vaultId: string, validPaths: ReadonlySet<string>): void;
  openPath(path: string): void;
  newTab(): void;
  close(paneId?: string, tabId?: string): void;
  confirmPendingClose(): void;
  cancelPendingClose(): void;
  reopenLast(validPaths?: ReadonlySet<string>): void;
  next(): void;
  previous(): void;
  activateIndex(index: number): void;
  activateTab(paneId: string, tabId: string): void;
  focusPane(paneId: string): void;
  focusNextPane(): void;
  moveTab(paneId: string, tabId: string, index: number): void;
  moveActiveTab(direction: -1 | 1): void;
  /** ⌘\ splits the active pane right; "column" splits down (§3.5). */
  splitActive(direction: SplitDirection): void;
  /** Drag-tab-to-edge: move a tab into a fresh split of `targetPaneId`. */
  splitWithTab(
    fromPaneId: string,
    tabId: string,
    targetPaneId: string,
    direction: SplitDirection,
  ): void;
  setSplitSize(splitId: string, size: number): void;
  markDirty(path: string, dirty: boolean): void;
  markMissing(path: string, missing: boolean): void;
  /** ⌘[ / ⌘] per-pane navigation (LOA-78). */
  navigateBack(): void;
  navigateForward(): void;
}

const DEFAULT_SPLIT_SIZE = 420;

export function createPanesStore() {
  let vaultId: string | null = null;

  return create<PanesState>()((set, get) => {
    const save = (): void => {
      if (vaultId) persistLayout(vaultId, get().root);
    };
    const updatePane = (paneId: string, update: (pane: PaneLeaf) => PaneLeaf): void => {
      const pane = findPane(get().root, paneId);
      if (!pane) return;
      set({ root: replacePane(get().root, paneId, update(pane)) });
      save();
    };
    const active = (): PaneLeaf => {
      const pane = findPane(get().root, get().activePaneId);
      return pane ?? firstPane(get().root);
    };
    /** Activate `path` in `paneId`, opening a tab when needed (no history). */
    const showPath = (paneId: string, path: string): void => {
      const pane = findPane(get().root, paneId);
      if (!pane) return;
      const existing = pane.tabs.find((tab) => tab.path === path);
      if (existing) {
        updatePane(paneId, (current) => ({ ...current, activeTabId: existing.id }));
        return;
      }
      const tab = makeTab(path);
      updatePane(paneId, (current) => ({
        ...current,
        tabs: [...current.tabs, tab],
        activeTabId: tab.id,
      }));
    };

    const removeTab = (paneId: string, tabId: string): void => {
      const pane = findPane(get().root, paneId);
      if (!pane) return;
      const index = pane.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return;
      const tab = pane.tabs[index] as Tab;
      const tabs = pane.tabs.filter((candidate) => candidate.id !== tabId);
      const nextActive =
        pane.activeTabId === tabId
          ? ((tabs[index] ?? tabs[index - 1])?.id ?? null)
          : pane.activeTabId;
      let root = replacePane(get().root, paneId, { ...pane, tabs, activeTabId: nextActive });
      // Empty non-root panes collapse into their sibling (AC1).
      root = collapseEmpty(root);
      const activePaneId = findPane(root, get().activePaneId)
        ? get().activePaneId
        : firstPane(root).id;
      set({
        root,
        activePaneId,
        closedStack: [{ path: tab.path, paneId }, ...get().closedStack].slice(0, 20),
        pendingClose: null,
      });
      save();
    };

    return {
      root: emptyPane(),
      activePaneId: "",
      closedStack: [],
      pendingClose: null,

      load(id, validPaths) {
        vaultId = id;
        const root = restoreLayout(id, validPaths);
        set({ root, activePaneId: firstPane(root).id, closedStack: [], pendingClose: null });
      },

      openPath(path) {
        const pane = active();
        showPath(pane.id, path);
        // Record the navigation: truncate forward history, skip duplicates.
        updatePane(pane.id, (current) => {
          const { entries, index } = current.history;
          if (entries[index]?.path === path) return current;
          const kept = entries.slice(0, index + 1);
          return {
            ...current,
            history: { entries: [...kept, { path, cursor: null }], index: kept.length },
          };
        });
        set({ activePaneId: pane.id });
      },

      newTab() {
        const pane = active();
        const tab = makeTab("");
        tab.title = "New tab";
        updatePane(pane.id, (current) => ({
          ...current,
          tabs: [...current.tabs, tab],
          activeTabId: tab.id,
        }));
      },

      close(paneId, tabId) {
        const pane = paneId ? findPane(get().root, paneId) : active();
        if (!pane) return;
        const target = tabId ?? pane.activeTabId;
        if (!target) return;
        const tab = pane.tabs.find((candidate) => candidate.id === target);
        if (!tab) return;
        if (tab.dirty) {
          set({ pendingClose: { paneId: pane.id, tab } });
          return;
        }
        removeTab(pane.id, target);
      },
      confirmPendingClose() {
        const pending = get().pendingClose;
        if (pending) removeTab(pending.paneId, pending.tab.id);
      },
      cancelPendingClose() {
        set({ pendingClose: null });
      },

      reopenLast(validPaths) {
        const [head, ...rest] = get().closedStack;
        if (!head) return;
        set({ closedStack: rest });
        if (!head.path || (validPaths && !validPaths.has(head.path))) {
          get().reopenLast(validPaths);
          return;
        }
        const paneId = findPane(get().root, head.paneId) ? head.paneId : active().id;
        const tab = makeTab(head.path);
        updatePane(paneId, (current) => ({
          ...current,
          tabs: [...current.tabs, tab],
          activeTabId: tab.id,
        }));
        set({ activePaneId: paneId });
      },

      next() {
        const pane = active();
        if (pane.tabs.length < 2) return;
        const index = pane.tabs.findIndex((tab) => tab.id === pane.activeTabId);
        const tab = pane.tabs[(index + 1) % pane.tabs.length] as Tab;
        updatePane(pane.id, (current) => ({ ...current, activeTabId: tab.id }));
      },
      previous() {
        const pane = active();
        if (pane.tabs.length < 2) return;
        const index = pane.tabs.findIndex((tab) => tab.id === pane.activeTabId);
        const tab = pane.tabs[(index - 1 + pane.tabs.length) % pane.tabs.length] as Tab;
        updatePane(pane.id, (current) => ({ ...current, activeTabId: tab.id }));
      },
      activateIndex(index) {
        const pane = active();
        const tab = index === 9 ? pane.tabs.at(-1) : pane.tabs[index - 1];
        if (tab) updatePane(pane.id, (current) => ({ ...current, activeTabId: tab.id }));
      },
      activateTab(paneId, tabId) {
        updatePane(paneId, (current) => ({ ...current, activeTabId: tabId }));
        set({ activePaneId: paneId });
      },
      focusPane(paneId) {
        if (findPane(get().root, paneId)) set({ activePaneId: paneId });
      },
      focusNextPane() {
        const panes = allPanes(get().root);
        const index = panes.findIndex((pane) => pane.id === get().activePaneId);
        const nextPane = panes[(index + 1) % panes.length];
        if (nextPane) set({ activePaneId: nextPane.id });
      },

      moveTab(paneId, tabId, index) {
        updatePane(paneId, (current) => {
          const from = current.tabs.findIndex((tab) => tab.id === tabId);
          if (from < 0) return current;
          const clamped = Math.max(0, Math.min(current.tabs.length - 1, index));
          const tabs = [...current.tabs];
          const [tab] = tabs.splice(from, 1);
          tabs.splice(clamped, 0, tab as Tab);
          return { ...current, tabs };
        });
      },
      moveActiveTab(direction) {
        const pane = active();
        if (!pane.activeTabId) return;
        const index = pane.tabs.findIndex((tab) => tab.id === pane.activeTabId);
        get().moveTab(pane.id, pane.activeTabId, index + direction);
      },

      splitActive(direction) {
        const pane = active();
        const fresh = emptyPane();
        set({
          root: splitPaneNode(get().root, pane.id, direction, fresh, DEFAULT_SPLIT_SIZE),
          activePaneId: fresh.id,
        });
        save();
      },

      splitWithTab(fromPaneId, tabId, targetPaneId, direction) {
        const from = findPane(get().root, fromPaneId);
        const tab = from?.tabs.find((candidate) => candidate.id === tabId);
        if (!from || !tab) return;
        // Remove from the source pane first.
        const remaining = from.tabs.filter((candidate) => candidate.id !== tabId);
        let root = replacePane(get().root, fromPaneId, {
          ...from,
          tabs: remaining,
          activeTabId:
            from.activeTabId === tabId ? (remaining.at(-1)?.id ?? null) : from.activeTabId,
        });
        const fresh: PaneLeaf = { ...emptyPane(), tabs: [tab], activeTabId: tab.id };
        root = splitPaneNode(root, targetPaneId, direction, fresh, DEFAULT_SPLIT_SIZE);
        root = collapseEmpty(root);
        set({ root, activePaneId: fresh.id });
        save();
      },

      setSplitSize(splitId, size) {
        const update = (node: PaneNode): PaneNode => {
          if (node.kind === "pane") return node;
          if (node.id === splitId) return { ...node, size };
          const first = update(node.first);
          const second = update(node.second);
          if (first === node.first && second === node.second) return node;
          return { ...node, first, second };
        };
        set({ root: update(get().root) });
        save();
      },

      navigateBack() {
        const pane = active();
        const { entries, index } = pane.history;
        if (index <= 0) return;
        const target = entries[index - 1] as NavEntry;
        updatePane(pane.id, (current) => ({
          ...current,
          history: { ...current.history, index: index - 1 },
        }));
        showPath(pane.id, target.path);
      },
      navigateForward() {
        const pane = active();
        const { entries, index } = pane.history;
        if (index >= entries.length - 1) return;
        const target = entries[index + 1] as NavEntry;
        updatePane(pane.id, (current) => ({
          ...current,
          history: { ...current.history, index: index + 1 },
        }));
        showPath(pane.id, target.path);
      },

      markDirty(path, dirty) {
        const update = (node: PaneNode): PaneNode => {
          if (node.kind === "pane") {
            return {
              ...node,
              tabs: node.tabs.map((tab) => (tab.path === path ? { ...tab, dirty } : tab)),
            };
          }
          return { ...node, first: update(node.first), second: update(node.second) };
        };
        set({ root: update(get().root) });
      },
      markMissing(path, missing) {
        const update = (node: PaneNode): PaneNode => {
          if (node.kind === "pane") {
            return {
              ...node,
              tabs: node.tabs.map((tab) => (tab.path === path ? { ...tab, missing } : tab)),
            };
          }
          return { ...node, first: update(node.first), second: update(node.second) };
        };
        set({ root: update(get().root) });
      },
    };
  });
}

export type PanesStore = ReturnType<typeof createPanesStore>;

/** Typed selectors (D2). */
export const selectRoot = (state: PanesState): PaneNode => state.root;
export const selectActivePaneId = (state: PanesState): string => state.activePaneId;
export const selectActiveTabOf =
  (paneId: string) =>
  (state: PanesState): Tab | null => {
    const pane = findPane(state.root, paneId);
    return pane?.tabs.find((tab) => tab.id === pane.activeTabId) ?? null;
  };
export const selectGlobalActiveTab = (state: PanesState): Tab | null => {
  const pane = findPane(state.root, state.activePaneId);
  return pane?.tabs.find((tab) => tab.id === pane.activeTabId) ?? null;
};
