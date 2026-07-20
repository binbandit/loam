/** LOA-72: files store — tree building, actions, persistence, §4.5 errors. */

import type { TreeEntryDto } from "@loam-app/ipc-client";
import { createMockTransport, MOCK_DEMO_VAULT_PATH } from "@loam-app/ipc-client";
import { describe, expect, it } from "vitest";
import { buildTree } from "../shell/FileTree";
import { createFilesStore, describeError, readPersisted } from "./files";

async function openDemo(transport = createMockTransport()) {
  const vault = await transport.openVaultPath(MOCK_DEMO_VAULT_PATH);
  const store = createFilesStore(transport);
  await store.getState().load(vault.id);
  return { transport, vault, store };
}

describe("tree building", () => {
  it("derives hierarchy from flat paths, folders first", async () => {
    const { store } = await openDemo();
    const nodes = buildTree(store.getState().entries, "name");
    expect(nodes[0]?.label).toBe("Projects");
    expect(nodes[0]?.children?.map((child) => child.label)).toEqual(["Garden", "Loam"]);
    expect(nodes.map((node) => node.label)).toEqual([
      "Projects",
      "Ideas",
      "Reading list",
      "Welcome to Loam",
    ]);
  });

  it("modified sort orders newest first within a level (AC4 sorting)", async () => {
    const { store } = await openDemo();
    const nodes = buildTree(store.getState().entries, "modified");
    const files = nodes.filter((node) => !node.children);
    // Mock stamps modifiedMs by path order; newest = last alphabetical path.
    expect(files[0]?.label).toBe("Welcome to Loam");
  });

  /** AC1: a 10k-entry vault builds and stays flat-windowed via E07. */
  it("builds a 10k-entry hierarchy without blowing up", () => {
    const entries: TreeEntryDto[] = [];
    for (let folder = 0; folder < 100; folder += 1) {
      entries.push({
        path: `f${folder}`,
        name: `f${folder}`,
        kind: "folder",
        size: 0,
        modifiedMs: null,
      });
      for (let note = 0; note < 99; note += 1) {
        entries.push({
          path: `f${folder}/n${note}.md`,
          name: `n${note}.md`,
          kind: "markdown",
          size: 10,
          modifiedMs: note,
        });
      }
    }
    const started = performance.now();
    const nodes = buildTree(entries, "name");
    expect(performance.now() - started).toBeLessThan(500);
    expect(nodes).toHaveLength(100);
    expect(nodes[0]?.children).toHaveLength(99);
  });
});

describe("mutations (§4.5, AC3/AC5)", () => {
  it("rename collision reports cause and preserves tree state", async () => {
    const { vault, store } = await openDemo();
    const before = store.getState().entries;
    store.getState().setExpanded(new Set(["Projects"]));
    store.getState().startRename("Ideas.md");
    await store.getState().commitRename(vault.id, "Ideas.md", "Reading list.md");
    const state = store.getState();
    expect(state.error).toContain("Couldn't rename");
    expect(state.error).toContain("already exists");
    expect(state.entries).toEqual(before);
    expect(state.expanded.has("Projects")).toBe(true);
    // Rename mode survives so the user can fix the name.
    expect(state.renamingPath).toBe("Ideas.md");
  });

  it("successful rename refreshes and exits rename mode", async () => {
    const { vault, store } = await openDemo();
    store.getState().startRename("Ideas.md");
    await store.getState().commitRename(vault.id, "Ideas.md", "Sparks.md");
    const state = store.getState();
    expect(state.error).toBeNull();
    expect(state.renamingPath).toBeNull();
    expect(state.entries.some((entry) => entry.path === "Sparks.md")).toBe(true);
    expect(state.entries.some((entry) => entry.path === "Ideas.md")).toBe(false);
  });

  it("trash removes the row only after core success (AC5)", async () => {
    const { transport, vault, store } = await openDemo();
    const commands = await transport.getCommands();
    const realTrash = commands.noteTrash;
    // Delay the command: the row must still be present mid-flight.
    let release: (() => void) | undefined;
    commands.noteTrash = async (vaultId, path) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return realTrash(vaultId, path);
    };
    const pending = store.getState().trash(vault.id, "Ideas.md");
    await Promise.resolve();
    expect(store.getState().entries.some((entry) => entry.path === "Ideas.md")).toBe(true);
    release?.();
    await pending;
    expect(store.getState().entries.some((entry) => entry.path === "Ideas.md")).toBe(false);
  });

  it("failed trash keeps the row and explains why (AC5)", async () => {
    const { transport, vault, store } = await openDemo();
    const commands = await transport.getCommands();
    commands.noteTrash = async () => ({
      status: "error",
      error: { error: "read-only", path: "Ideas.md" },
    });
    await store.getState().trash(vault.id, "Ideas.md");
    expect(store.getState().entries.some((entry) => entry.path === "Ideas.md")).toBe(true);
    expect(store.getState().error).toBe("Couldn't move to trash: the vault is read-only");
  });

  it("create note and duplicate refresh the tree", async () => {
    const { vault, store } = await openDemo();
    await store.getState().createNote(vault.id, "Projects");
    expect(store.getState().entries.some((entry) => entry.path === "Projects/Untitled.md")).toBe(
      true,
    );
    await store.getState().duplicate(vault.id, "Ideas.md");
    expect(store.getState().entries.some((entry) => entry.path === "Ideas 1.md")).toBe(true);
  });
});

describe("persistence (AC4)", () => {
  it("collapse and sort state restore per device", async () => {
    const transport = createMockTransport();
    const vault = await transport.openVaultPath(MOCK_DEMO_VAULT_PATH);
    const first = createFilesStore(transport);
    await first.getState().load(vault.id);
    first.getState().setExpanded(new Set(["Projects"]));
    first.getState().setSort("modified");
    expect(readPersisted(vault.id)).toEqual({ expanded: ["Projects"], sort: "modified" });

    // A fresh store (new session) restores both.
    const second = createFilesStore(transport);
    await second.getState().load(vault.id);
    expect(second.getState().expanded.has("Projects")).toBe(true);
    expect(second.getState().sort).toBe("modified");
  });
});

describe("error copy", () => {
  it("kebab tags become plain cause text", () => {
    expect(describeError("rename", new Error("boom"))).toBe("Couldn't rename: boom");
  });
});
