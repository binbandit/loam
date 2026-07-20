/** LOA-84: status-line bindings. */

import { createMockTransport, MOCK_DEMO_VAULT_PATH } from "@loam-app/ipc-client";
import { describe, expect, it, vi } from "vitest";
import { countText, createStatusStore, indexStatusText } from "./status";

describe("status store", () => {
  it("follows index-progress events for its own vault only (AC4 data)", async () => {
    const transport = createMockTransport();
    const vault = await transport.openVaultPath(MOCK_DEMO_VAULT_PATH);
    const store = createStatusStore();
    await store.getState().start(transport, vault.id, vault.indexStatus);
    expect(store.getState().indexStatus).toBe("notIndexed");

    transport.mock?.emitIndexProgress(vault.id, { done: 2, total: 10 });
    expect(store.getState().indexStatus).toBe("indexing");
    expect(store.getState().indexProgress).toEqual({ done: 2, total: 10 });
    // Another vault's events are dropped (§5.4 defense-in-depth).
    transport.mock?.emitIndexProgress("other-vault", { done: 9, total: 10 });
    expect(store.getState().indexProgress).toEqual({ done: 2, total: 10 });

    transport.mock?.emitIndexProgress(vault.id, { done: 10, total: 10 });
    expect(store.getState().indexStatus).toBe("ready");
    expect(store.getState().indexProgress).toBeNull();
  });

  it("index status always has text beyond the glyph (AC4)", () => {
    expect(indexStatusText("ready", null)).toBe("Index ready");
    expect(indexStatusText("indexing", { done: 3, total: 9 })).toBe("Indexing 3/9");
    expect(indexStatusText("indexing", null)).toBe("Indexing");
    expect(indexStatusText("notIndexed", null)).toBe("Not indexed");
  });

  it("counts are debounced off the keystroke path (AC2)", async () => {
    vi.useFakeTimers();
    const store = createStatusStore();
    store.getState().setNoteContent("one two three");
    // Immediately after "typing": nothing computed yet.
    expect(store.getState().counts).toBeNull();
    store.getState().setNoteContent("one two three four");
    vi.advanceTimersByTime(200);
    // Only the final content was counted, once.
    expect(store.getState().counts).toEqual({ words: 4, characters: 18 });
    vi.useRealTimers();
  });

  it("countText handles markdown-ish text", () => {
    expect(countText("# Hello\n\nworld  again\n")).toEqual({ words: 4, characters: 22 });
    expect(countText("")).toEqual({ words: 0, characters: 0 });
  });

  it("cursor renders only when an editor reports one (AC3)", () => {
    const store = createStatusStore();
    expect(store.getState().cursor).toBeNull();
    store.getState().setCursor({ line: 4, ch: 12 });
    expect(store.getState().cursor).toEqual({ line: 4, ch: 12 });
    store.getState().setCursor(null);
    expect(store.getState().cursor).toBeNull();
  });

  it("plugin items register once; count display toggles", () => {
    const store = createStatusStore();
    const item = { id: "wc", render: () => null };
    store.getState().registerPluginItem(item);
    store.getState().registerPluginItem(item);
    expect(store.getState().pluginItems).toHaveLength(1);
    expect(store.getState().countDisplay).toBe("words");
    store.getState().toggleCountDisplay();
    expect(store.getState().countDisplay).toBe("characters");
  });
});
