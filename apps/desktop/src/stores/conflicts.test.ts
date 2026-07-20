/** LOA-89: §5.6 conflict flows against the mock transport. */

import { createMockTransport, MOCK_DEMO_VAULT_PATH, mockHash } from "@loam-app/ipc-client";
import { describe, expect, it } from "vitest";
import { createConflictsStore } from "./conflicts";

async function harness(dirtyPaths: string[] = []) {
  const transport = createMockTransport();
  const vault = await transport.openVaultPath(MOCK_DEMO_VAULT_PATH);
  const store = createConflictsStore();
  const dirty = new Set(dirtyPaths);
  await store.getState().start(transport, vault.id, (path) => dirty.has(path));
  return { transport, vault, store };
}

describe("conflict store", () => {
  it("clean external changes silently bump the reload generation (AC1)", async () => {
    const { transport, vault, store } = await harness();
    transport.mock?.emitExternalChange(vault.id, "Ideas.md", "# changed outside\n");
    expect(store.getState().reloadGeneration["Ideas.md"]).toBe(1);
    expect(store.getState().conflicts["Ideas.md"]).toBeUndefined();
    // Another vault's changes are ignored.
    transport.mock?.emitExternalChange("other", "Ideas.md", "x");
    expect(store.getState().reloadGeneration["Ideas.md"]).toBe(1);
  });

  it("dirty buffers get a banner, not a reload (AC2)", async () => {
    const { transport, vault, store } = await harness(["Ideas.md"]);
    transport.mock?.emitExternalChange(vault.id, "Ideas.md", "# disk version\n");
    expect(store.getState().reloadGeneration["Ideas.md"]).toBeUndefined();
    transport.mock?.emitConflict(vault.id, {
      path: "Ideas.md",
      mine: "# my edits\n",
      disk: "# disk version\n",
      base: "# original\n",
      diskHash: mockHash("# disk version\n"),
    });
    expect(store.getState().conflicts["Ideas.md"]?.mine).toBe("# my edits\n");
  });

  it("keep mine writes with the current disk hash and clears (AC4 happy)", async () => {
    const { transport, vault, store } = await harness(["Ideas.md"]);
    const commands = await transport.getCommands();
    // Externally change the file so its hash is the conflict's diskHash.
    transport.mock?.emitExternalChange(vault.id, "Ideas.md", "# disk version\n");
    transport.mock?.emitConflict(vault.id, {
      path: "Ideas.md",
      mine: "# my edits\n",
      disk: "# disk version\n",
      base: null,
      diskHash: mockHash("# disk version\n"),
    });
    await store.getState().keepMine(transport, vault.id, "Ideas.md");
    expect(store.getState().conflicts["Ideas.md"]).toBeUndefined();
    const readBack = await commands.noteRead(vault.id, "Ideas.md");
    expect(readBack.status === "ok" && readBack.data.content).toBe("# my edits\n");
  });

  it("keep mine against a moved disk reports a second conflict safely (AC4)", async () => {
    const { transport, vault, store } = await harness(["Ideas.md"]);
    transport.mock?.emitConflict(vault.id, {
      path: "Ideas.md",
      mine: "# my edits\n",
      disk: "# old disk\n",
      base: null,
      diskHash: mockHash("# old disk\n"), // stale: disk moved again since
    });
    transport.mock?.emitExternalChange(vault.id, "Ideas.md", "# even newer disk\n");
    await store.getState().keepMine(transport, vault.id, "Ideas.md");
    // Nothing clobbered: the conflict stays, with a §4.5 explanation.
    expect(store.getState().conflicts["Ideas.md"]).toBeDefined();
    expect(store.getState().errors["Ideas.md"]).toContain("changed on disk again");
    const commands = await transport.getCommands();
    const readBack = await commands.noteRead(vault.id, "Ideas.md");
    expect(readBack.status === "ok" && readBack.data.content).toBe("# even newer disk\n");
  });

  it("take disk requires explicit activation and reloads (AC3)", async () => {
    const { transport, vault, store } = await harness(["Ideas.md"]);
    transport.mock?.emitConflict(vault.id, {
      path: "Ideas.md",
      mine: "# my edits\n",
      disk: "# disk\n",
      base: null,
      diskHash: mockHash("# disk\n"),
    });
    // Nothing happens implicitly.
    expect(store.getState().conflicts["Ideas.md"]).toBeDefined();
    expect(store.getState().reloadGeneration["Ideas.md"]).toBeUndefined();
    store.getState().takeDisk("Ideas.md");
    expect(store.getState().conflicts["Ideas.md"]).toBeUndefined();
    expect(store.getState().reloadGeneration["Ideas.md"]).toBe(1);
  });

  it("merge surface opens from both versions and writes nothing until chosen (AC5)", async () => {
    const { transport, vault, store } = await harness(["Ideas.md"]);
    const commands = await transport.getCommands();
    const before = await commands.noteRead(vault.id, "Ideas.md");
    transport.mock?.emitConflict(vault.id, {
      path: "Ideas.md",
      mine: "# my edits\n",
      disk: "# disk\n",
      base: "# base\n",
      diskHash: mockHash("# disk\n"),
    });
    store.getState().openMerge("Ideas.md");
    expect(store.getState().merging).toBe("Ideas.md");
    const conflict = store.getState().conflicts["Ideas.md"];
    expect(conflict?.mine).toBe("# my edits\n");
    expect(conflict?.disk).toBe("# disk\n");
    expect(conflict?.base).toBe("# base\n");
    // Opening the surface wrote nothing.
    const after = await commands.noteRead(vault.id, "Ideas.md");
    expect(after.status === "ok" && after.data.content).toBe(
      before.status === "ok" && before.data.content,
    );
    store.getState().closeMerge();
    expect(store.getState().merging).toBeNull();
    expect(store.getState().conflicts["Ideas.md"]).toBeDefined();
  });
});
