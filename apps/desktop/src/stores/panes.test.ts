/** LOA-75/LOA-76: pane layout reducers, tab lifecycle, and persistence. */

import { describe, expect, it } from "vitest";
import { runShellCommand } from "../shell/TabBar";
import {
  allPanes,
  collapseEmpty,
  createPanesStore,
  emptyPane,
  findPane,
  firstPane,
  isValidTree,
  type PaneNode,
  persistLayout,
  restoreLayout,
  selectGlobalActiveTab,
  splitPaneNode,
} from "./panes";

const ALL = new Set(["a.md", "b.md", "c.md"]);

function storeWith(paths: string[]) {
  const store = createPanesStore();
  store.getState().load(`v-${Math.random().toString(36).slice(2)}`, ALL);
  for (const path of paths) store.getState().openPath(path);
  return store;
}

function activePath(store: ReturnType<typeof createPanesStore>): string | undefined {
  return selectGlobalActiveTab(store.getState())?.path;
}

/** AC1: the recursive reducers keep trees valid. */
describe("layout reducers", () => {
  it("splits nest arbitrarily and stay structurally valid", () => {
    let tree: PaneNode = emptyPane();
    const rootId = tree.id;
    tree = splitPaneNode(tree, rootId, "row", emptyPane(), 400);
    const right = allPanes(tree)[1] as PaneNode;
    tree = splitPaneNode(tree, right.id, "column", emptyPane(), 300);
    expect(isValidTree(tree)).toBe(true);
    expect(allPanes(tree)).toHaveLength(3);
    // Unknown pane id: no-op, still valid.
    expect(splitPaneNode(tree, "missing", "row", emptyPane(), 100)).toBe(tree);
  });

  it("collapseEmpty folds empty panes into their sibling", () => {
    let tree: PaneNode = emptyPane();
    tree = splitPaneNode(tree, tree.id, "row", emptyPane(), 400);
    const [left] = allPanes(tree);
    const filled = { ...(left as ReturnType<typeof emptyPane>), tabs: [] };
    void filled;
    // Both children empty: collapses to a single pane.
    const collapsed = collapseEmpty(tree);
    expect(collapsed.kind).toBe("pane");
    expect(isValidTree(collapsed)).toBe(true);
  });
});

/** LOA-75 lifecycle semantics, now per-pane. */
describe("tab lifecycle", () => {
  it("open activates existing tabs; command and pointer paths agree", () => {
    const store = storeWith(["a.md", "b.md"]);
    store.getState().openPath("a.md");
    const pane = firstPane(store.getState().root);
    expect(pane.tabs.map((tab) => tab.path)).toEqual(["a.md", "b.md"]);
    expect(activePath(store)).toBe("a.md");
    runShellCommand(store, "tab.next");
    expect(activePath(store)).toBe("b.md");
    runShellCommand(store, "tab.activate1");
    expect(activePath(store)).toBe("a.md");
  });

  it("dirty close parks a decision; confirm closes (AC2)", () => {
    const store = storeWith(["a.md"]);
    store.getState().markDirty("a.md", true);
    runShellCommand(store, "tab.close");
    expect(store.getState().pendingClose?.tab.path).toBe("a.md");
    expect(firstPane(store.getState().root).tabs).toHaveLength(1);
    store.getState().confirmPendingClose();
    expect(firstPane(store.getState().root).tabs).toHaveLength(0);
  });

  it("reopen restores the last closed valid tab (AC3)", () => {
    const store = storeWith(["a.md", "b.md"]);
    runShellCommand(store, "tab.close"); // closes b
    runShellCommand(store, "tab.reopen", ALL);
    expect(firstPane(store.getState().root).tabs.map((tab) => tab.path)).toEqual(["a.md", "b.md"]);
  });

  it("reorder commands clamp and match pointer moves (AC4)", () => {
    const store = storeWith(["a.md", "b.md", "c.md"]);
    runShellCommand(store, "tab.activate1");
    runShellCommand(store, "tab.moveRight");
    expect(firstPane(store.getState().root).tabs.map((tab) => tab.path)).toEqual([
      "b.md",
      "a.md",
      "c.md",
    ]);
    runShellCommand(store, "tab.moveLeft");
    runShellCommand(store, "tab.moveLeft");
    expect(firstPane(store.getState().root).tabs.map((tab) => tab.path)).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
  });
});

/** LOA-76 pane behavior. */
describe("pane splits", () => {
  it("⌘\\ (pane.splitRight) creates and focuses a fresh right pane (AC2)", () => {
    const store = storeWith(["a.md"]);
    runShellCommand(store, "pane.splitRight");
    const { root, activePaneId } = store.getState();
    expect(root.kind).toBe("split");
    const panes = allPanes(root);
    expect(panes).toHaveLength(2);
    expect(activePaneId).toBe(panes[1]?.id);
    expect(panes[1]?.tabs).toHaveLength(0);
    // Opening a note lands in the new focused pane.
    store.getState().openPath("b.md");
    expect(findPane(store.getState().root, activePaneId)?.tabs[0]?.path).toBe("b.md");
  });

  it("splitWithTab moves a tab into a fresh split (drag-to-edge, AC3)", () => {
    const store = storeWith(["a.md", "b.md"]);
    const pane = firstPane(store.getState().root);
    const tab = pane.tabs[1];
    store.getState().splitWithTab(pane.id, tab?.id as string, pane.id, "column");
    const panes = allPanes(store.getState().root);
    expect(panes).toHaveLength(2);
    expect(panes[0]?.tabs.map((entry) => entry.path)).toEqual(["a.md"]);
    expect(panes[1]?.tabs.map((entry) => entry.path)).toEqual(["b.md"]);
    expect(isValidTree(store.getState().root)).toBe(true);
  });

  it("closing the last tab of a split pane collapses it (AC1)", () => {
    const store = storeWith(["a.md"]);
    runShellCommand(store, "pane.splitRight");
    store.getState().openPath("b.md");
    runShellCommand(store, "tab.close"); // empties + collapses the new pane
    const { root, activePaneId } = store.getState();
    expect(root.kind).toBe("pane");
    expect(findPane(root, activePaneId)).not.toBeNull();
  });

  it("resizes persist and restore (AC4)", () => {
    const vaultId = "resize-vault";
    const store = createPanesStore();
    store.getState().load(vaultId, ALL);
    store.getState().openPath("a.md");
    runShellCommand(store, "pane.splitRight");
    store.getState().openPath("b.md");
    const splitId = store.getState().root.id;
    store.getState().setSplitSize(splitId, 333);

    const fresh = createPanesStore();
    fresh.getState().load(vaultId, ALL);
    const root = fresh.getState().root;
    expect(root.kind).toBe("split");
    expect(root.kind === "split" && root.size).toBe(333);
    expect(allPanes(root).flatMap((pane) => pane.tabs.map((tab) => tab.path))).toEqual([
      "a.md",
      "b.md",
    ]);
  });
});

/** AC5: corrupt/stale workspace state falls back, files untouched. */
describe("restore safety", () => {
  it("corrupt JSON falls back to one empty pane", () => {
    const vaultId = "corrupt-vault";
    window.localStorage?.setItem?.(`loam.layout.${vaultId}`, "{not json");
    const root = restoreLayout(vaultId, ALL);
    expect(root.kind).toBe("pane");
    expect(isValidTree(root)).toBe(true);
  });

  it("structurally invalid trees fall back", () => {
    const vaultId = "invalid-vault";
    persistLayout(vaultId, emptyPane());
    // Overwrite with a wrong shape but valid JSON.
    const key = `loam.layout.${vaultId}`;
    const raw = JSON.stringify({ version: 1, root: { kind: "split", first: null } });
    try {
      window.localStorage?.setItem?.(key, raw);
    } catch {
      /* memory fallback path */
    }
    const root = restoreLayout(vaultId, ALL);
    expect(root.kind).toBe("pane");
  });

  it("missing notes are dropped and empty panes collapse on restore", () => {
    const vaultId = "stale-vault";
    const store = createPanesStore();
    store.getState().load(vaultId, ALL);
    store.getState().openPath("a.md");
    runShellCommand(store, "pane.splitRight");
    store.getState().openPath("c.md");
    // c.md was deleted since: restore keeps a.md and collapses the pane.
    const fresh = createPanesStore();
    fresh.getState().load(vaultId, new Set(["a.md", "b.md"]));
    const root = fresh.getState().root;
    expect(root.kind).toBe("pane");
    expect(firstPane(root).tabs.map((tab) => tab.path)).toEqual(["a.md"]);
  });
});

/** LOA-78: per-pane navigation history. */
describe("navigation history", () => {
  it("each pane keeps an independent stack (AC1)", () => {
    const store = storeWith(["a.md"]);
    runShellCommand(store, "pane.splitRight");
    store.getState().openPath("b.md");
    store.getState().openPath("c.md");
    runShellCommand(store, "nav.back");
    expect(activePath(store)).toBe("b.md");
    // The first pane's history is untouched: focusing it, back is a no-op.
    const first = allPanes(store.getState().root)[0];
    store.getState().focusPane(first?.id as string);
    runShellCommand(store, "nav.back");
    expect(selectGlobalActiveTab(store.getState())?.path).toBe("a.md");
  });

  it("back returns and forward replays; entries carry a cursor slot (AC2)", () => {
    const store = storeWith(["a.md", "b.md"]);
    runShellCommand(store, "nav.back");
    expect(activePath(store)).toBe("a.md");
    runShellCommand(store, "nav.forward");
    expect(activePath(store)).toBe("b.md");
    const pane = firstPane(store.getState().root);
    expect(pane.history.entries.every((entry) => "cursor" in entry)).toBe(true);
  });

  it("new navigation after back truncates the forward branch (AC3)", () => {
    const store = storeWith(["a.md", "b.md"]);
    runShellCommand(store, "nav.back"); // at a
    store.getState().openPath("c.md"); // branches
    const pane = firstPane(store.getState().root);
    expect(pane.history.entries.map((entry) => entry.path)).toEqual(["a.md", "c.md"]);
    runShellCommand(store, "nav.forward"); // nothing forward
    expect(activePath(store)).toBe("c.md");
  });

  it("navigating to the current note does not duplicate entries (AC4)", () => {
    const store = storeWith(["a.md"]);
    store.getState().openPath("a.md");
    store.getState().openPath("a.md");
    expect(firstPane(store.getState().root).history.entries.map((entry) => entry.path)).toEqual([
      "a.md",
    ]);
  });

  it("back reopens a note whose tab was closed", () => {
    const store = storeWith(["a.md", "b.md"]);
    // Close a's tab, then navigate back to it.
    const pane = firstPane(store.getState().root);
    store.getState().close(pane.id, pane.tabs[0]?.id);
    runShellCommand(store, "nav.back");
    expect(activePath(store)).toBe("a.md");
  });
});
