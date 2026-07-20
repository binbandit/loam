/** LOA-91: per-device workspace.json — round-trip, debounce, recovery. */

import { createMockTransport, MOCK_DEMO_VAULT_PATH } from "@loam-app/ipc-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDeviceStorage } from "./device-storage";
import { allPanes, createPanesStore, firstPane } from "./panes";
import { createWorkspaceCoordinator } from "./workspace-file";

afterEach(() => {
  setDeviceStorage(null);
  vi.useRealTimers();
});

async function harness() {
  const transport = createMockTransport();
  const vault = await transport.openVaultPath(MOCK_DEMO_VAULT_PATH);
  const coordinator = createWorkspaceCoordinator(transport);
  await coordinator.load(vault.id);
  setDeviceStorage(coordinator.storage);
  return { transport, vault, coordinator };
}

describe("workspace coordinator", () => {
  it("a representative multi-pane workspace restores exactly (AC1)", async () => {
    const { transport, vault, coordinator } = await harness();
    const panes = createPanesStore();
    panes.getState().load(vault.id, new Set(["Ideas.md", "Reading list.md"]));
    panes.getState().openPath("Ideas.md");
    panes.getState().splitActive("row");
    panes.getState().openPath("Reading list.md");
    panes.getState().setSplitSize(panes.getState().root.id, 350);
    await coordinator.flush();

    // A fresh session: new coordinator, new store, same vault.
    const restoredCoordinator = createWorkspaceCoordinator(transport);
    await restoredCoordinator.load(vault.id);
    setDeviceStorage(restoredCoordinator.storage);
    const restored = createPanesStore();
    restored.getState().load(vault.id, new Set(["Ideas.md", "Reading list.md"]));
    const root = restored.getState().root;
    expect(root.kind).toBe("split");
    expect(root.kind === "split" && root.size).toBe(350);
    expect(allPanes(root).map((pane) => pane.tabs.map((tab) => tab.path))).toEqual([
      ["Ideas.md"],
      ["Reading list.md"],
    ]);
  });

  it("rapid changes coalesce into one atomic write with the final state (AC2)", async () => {
    vi.useFakeTimers();
    const { transport, vault, coordinator } = await harness();
    const commands = await transport.getCommands();
    const writeSpy = vi.fn(commands.workspaceWrite);
    commands.workspaceWrite = writeSpy;

    for (let step = 0; step < 20; step += 1) {
      coordinator.storage.setItem("loam.test.section", JSON.stringify({ step }));
    }
    expect(writeSpy).not.toHaveBeenCalled(); // nothing on the keystroke path
    expect(coordinator.hasPendingWrite()).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeSpy.mock.calls[0]?.[1] as string) as {
      sections: Record<string, string>;
    };
    expect(JSON.parse(written.sections["loam.test.section"] as string)).toEqual({ step: 19 });
    void vault;
  });

  it("corrupt workspace data is quarantined and falls back (AC3)", async () => {
    const transport = createMockTransport();
    const vault = await transport.openVaultPath(MOCK_DEMO_VAULT_PATH);
    const commands = await transport.getCommands();
    await commands.workspaceWrite(vault.id, "{definitely not json");
    const coordinator = createWorkspaceCoordinator(transport);
    await coordinator.load(vault.id);
    // Fallback: empty sections.
    expect(coordinator.storage.getItem("anything")).toBeNull();
    // Quarantined: the original file is gone (moved aside), not overwritten.
    const readBack = await commands.workspaceRead(vault.id);
    expect(readBack.status === "ok" && readBack.data).toBeNull();
  });

  it("missing notes restore as recoverable state, not errors (AC4)", async () => {
    const { transport, vault, coordinator } = await harness();
    const panes = createPanesStore();
    panes.getState().load(vault.id, new Set(["Ideas.md", "Gone.md"]));
    panes.getState().openPath("Ideas.md");
    panes.getState().openPath("Gone.md");
    await coordinator.flush();

    const freshCoordinator = createWorkspaceCoordinator(transport);
    await freshCoordinator.load(vault.id);
    setDeviceStorage(freshCoordinator.storage);
    const restored = createPanesStore();
    restored.getState().load(vault.id, new Set(["Ideas.md"])); // Gone.md deleted
    expect(firstPane(restored.getState().root).tabs.map((tab) => tab.path)).toEqual(["Ideas.md"]);
  });

  it("no workspace state is ever written inside the vault (AC5)", async () => {
    const { transport, vault, coordinator } = await harness();
    const commands = await transport.getCommands();
    const treeBefore = await commands.vaultTree(vault.id);
    coordinator.storage.setItem("loam.layout.x", "{}");
    await coordinator.flush();
    const treeAfter = await commands.vaultTree(vault.id);
    expect(treeAfter).toEqual(treeBefore);
    const inVault = await commands.noteRead(vault.id, "workspace.json");
    expect(inVault.status).toBe("error");
  });
});
