/** LOA-69: save + dirty-state flow against the mock transport. */

import { createMockTransport, MOCK_DEMO_VAULT_PATH } from "@loam-app/ipc-client";
import { describe, expect, it, vi } from "vitest";
import { createConflictsStore } from "./conflicts";
import { createSavesStore, type SavesOptions } from "./saves";

const PATH = "Ideas.md";

async function harness(options: SavesOptions = {}) {
  const transport = createMockTransport();
  const vault = await transport.openVaultPath(MOCK_DEMO_VAULT_PATH);
  const commands = await transport.getCommands();
  const read = await commands.noteRead(vault.id, PATH);
  if (read.status !== "ok") throw new Error("fixture read failed");
  const store = createSavesStore(transport, { autosaveMs: 20, ...options });
  store.getState().register(vault.id, PATH, read.data.content ?? "", read.data.hash);
  return { transport, vault, commands, store, initial: read.data };
}

const diskContent = async (
  commands: Awaited<ReturnType<ReturnType<typeof createMockTransport>["getCommands"]>>,
  vaultId: string,
): Promise<string | null> => {
  const result = await commands.noteRead(vaultId, PATH);
  return result.status === "ok" ? result.data.content : null;
};

describe("dirty tracking (AC1)", () => {
  it("editing marks the session dirty and notifies the tab", async () => {
    const onDirtyChange = vi.fn();
    const { store } = await harness({ onDirtyChange });
    expect(store.getState().entries[PATH]?.status).toBe("clean");
    store.getState().edited(PATH, "# Ideas\n\nnew text\n");
    expect(store.getState().entries[PATH]?.status).toBe("dirty");
    expect(store.getState().isDirty(PATH)).toBe(true);
    expect(onDirtyChange).toHaveBeenCalledWith(PATH, true);
    // Autosave is scheduled, not run inline (off the keystroke path).
    expect(store.getState().hasScheduledSave(PATH)).toBe(true);
  });
});

describe("successful save (AC2)", () => {
  it("clears dirty, advances the base hash, and writes the content", async () => {
    const onDirtyChange = vi.fn();
    const onSaved = vi.fn();
    const { store, commands, vault, initial } = await harness({ onDirtyChange, onSaved });
    store.getState().edited(PATH, "# Ideas\n\nsaved body\n");
    await store.getState().saveNow(PATH);

    const entry = store.getState().entries[PATH];
    expect(entry?.status).toBe("clean");
    expect(entry?.baseHash).not.toBe(initial.hash);
    expect(store.getState().isDirty(PATH)).toBe(false);
    expect(onDirtyChange).toHaveBeenLastCalledWith(PATH, false);
    expect(onSaved).toHaveBeenCalledWith(PATH, entry?.baseHash);
    expect(await diskContent(commands, vault.id)).toBe("# Ideas\n\nsaved body\n");
  });

  it("autosave fires on its own after the debounce", async () => {
    const { store, commands, vault } = await harness({ autosaveMs: 10 });
    store.getState().edited(PATH, "autosaved\n");
    await vi.waitFor(() => expect(store.getState().entries[PATH]?.status).toBe("clean"));
    expect(await diskContent(commands, vault.id)).toBe("autosaved\n");
  });

  it("a second save from the advanced hash succeeds (no self-conflict)", async () => {
    const { store, commands, vault } = await harness();
    store.getState().edited(PATH, "first\n");
    await store.getState().saveNow(PATH);
    store.getState().edited(PATH, "second\n");
    await store.getState().saveNow(PATH);
    expect(store.getState().entries[PATH]?.status).toBe("clean");
    expect(await diskContent(commands, vault.id)).toBe("second\n");
  });
});

describe("failed and conflicted saves (AC3)", () => {
  it("a stale base hash conflicts, keeps the buffer, and never clobbers disk", async () => {
    const { store, commands, vault, transport } = await harness();
    // Someone else writes the file: our base hash goes stale.
    transport.mock?.emitExternalChange(vault.id, PATH, "# from another app\n");
    store.getState().edited(PATH, "# my unsaved work\n");
    await store.getState().saveNow(PATH);

    const entry = store.getState().entries[PATH];
    expect(entry?.status).toBe("conflict");
    expect(entry?.conflictHash).toBeTruthy();
    expect(entry?.content).toBe("# my unsaved work\n");
    expect(store.getState().isDirty(PATH)).toBe(true);
    // Disk still holds the other app's version.
    expect(await diskContent(commands, vault.id)).toBe("# from another app\n");
  });

  it("a plain failure keeps the content dirty with cause-and-remedy copy", async () => {
    const { store, commands } = await harness();
    commands.noteWrite = async () => ({
      status: "error",
      error: { error: "read-only", path: PATH },
    });
    store.getState().edited(PATH, "unsaveable\n");
    await store.getState().saveNow(PATH);
    const entry = store.getState().entries[PATH];
    expect(entry?.status).toBe("error");
    expect(entry?.error).toBe("Couldn't save: the vault is read-only");
    expect(entry?.content).toBe("unsaveable\n");
  });

  it("edits while conflicted stay conflicted until resolution", async () => {
    const { store, vault, transport } = await harness();
    transport.mock?.emitExternalChange(vault.id, PATH, "disk\n");
    store.getState().edited(PATH, "mine\n");
    await store.getState().saveNow(PATH);
    expect(store.getState().entries[PATH]?.status).toBe("conflict");
    store.getState().edited(PATH, "mine again\n");
    expect(store.getState().entries[PATH]?.status).toBe("conflict");
    expect(store.getState().entries[PATH]?.content).toBe("mine again\n");
  });
});

describe("edits during an in-flight save (AC4)", () => {
  it("saves the newest content after the write in flight completes", async () => {
    const { store, commands, vault } = await harness();
    // Hold the first write open until we have typed more.
    let release: (() => void) | undefined;
    const realWrite = commands.noteWrite;
    let calls = 0;
    commands.noteWrite = async (vaultId, path, content, baseHash) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realWrite(vaultId, path, content, baseHash);
    };

    store.getState().edited(PATH, "first\n");
    const saving = store.getState().saveNow(PATH);
    await vi.waitFor(() => expect(store.getState().entries[PATH]?.status).toBe("saving"));
    // Typed while the write is in flight.
    store.getState().edited(PATH, "newest\n");
    release?.();
    await saving;
    await vi.waitFor(() => expect(store.getState().entries[PATH]?.status).toBe("clean"));

    expect(calls).toBe(2);
    expect(await diskContent(commands, vault.id)).toBe("newest\n");
  });
});

describe("session lifetime (AC5)", () => {
  it("switching notes never discards unsaved content", async () => {
    const { store, vault } = await harness();
    store.getState().edited(PATH, "unsaved work\n");
    // Another note becomes active and is registered; the first is untouched.
    store.getState().register(vault.id, "Reading list.md", "other\n", "hash-2");
    store.getState().edited("Reading list.md", "other edited\n");
    expect(store.getState().entries[PATH]?.content).toBe("unsaved work\n");
    expect(store.getState().entries[PATH]?.status).toBe("dirty");
    // Returning re-registers only after a fresh read; the dirty buffer is
    // still the store's source of truth until then.
    expect(store.getState().isDirty(PATH)).toBe(true);
  });

  it("forget clears tracking and cancels a pending autosave", async () => {
    const { store } = await harness({ autosaveMs: 10_000 });
    store.getState().edited(PATH, "dirty\n");
    expect(store.getState().hasScheduledSave(PATH)).toBe(true);
    store.getState().forget(PATH);
    expect(store.getState().hasScheduledSave(PATH)).toBe(false);
    expect(store.getState().entries[PATH]).toBeUndefined();
  });
});

describe("watcher-origin suppression", () => {
  it("the app's own writes never trigger a reload of the buffer", async () => {
    const { store, transport, vault } = await harness();
    const conflicts = createConflictsStore();
    await conflicts.getState().start(transport, vault.id, () => false);

    store.getState().edited(PATH, "typed here\n");
    await store.getState().saveNow(PATH);
    // The save emitted an app-origin file-changed event; a reload here would
    // stomp the buffer the user is typing in (§5.6).
    expect(conflicts.getState().reloadGeneration[PATH]).toBeUndefined();

    // An external write to the same note still reloads.
    transport.mock?.emitExternalChange(vault.id, PATH, "from elsewhere\n");
    expect(conflicts.getState().reloadGeneration[PATH]).toBe(1);
  });
});

describe("re-reads while dirty", () => {
  it("re-registering a dirty note keeps the buffer and its base hash (AC5)", async () => {
    const { store, vault, initial } = await harness({ autosaveMs: 10_000 });
    store.getState().edited(PATH, "unsaved work\n");
    // Tab switch away and back re-reads the note from disk.
    store.getState().register(vault.id, PATH, initial.content ?? "", initial.hash);
    const entry = store.getState().entries[PATH];
    expect(entry?.content).toBe("unsaved work\n");
    expect(entry?.status).toBe("dirty");
    expect(entry?.baseHash).toBe(initial.hash);
  });

  it("re-registering a clean note adopts the fresh disk bytes", async () => {
    const { store, vault } = await harness();
    store.getState().register(vault.id, PATH, "changed on disk\n", "new-hash");
    const entry = store.getState().entries[PATH];
    expect(entry?.content).toBe("changed on disk\n");
    expect(entry?.baseHash).toBe("new-hash");
    expect(entry?.status).toBe("clean");
  });
});
