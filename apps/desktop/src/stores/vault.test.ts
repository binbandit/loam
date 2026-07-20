/** LOA-66: vault store flows against the mock transport. */

import { createMockTransport, LoamIpcError } from "@loam-app/ipc-client";
import { describe, expect, it } from "vitest";
import { createVaultStore } from "./vault";

describe("vault store", () => {
  it("opens the demo vault through the picker", async () => {
    const store = createVaultStore(createMockTransport());
    expect(store.getState().status).toBe("no-vault");
    await store.getState().openFromPicker();
    const state = store.getState();
    expect(state.status).toBe("open");
    expect(state.vault?.name).toBe("Loam Demo");
    expect(state.vault?.counts.notes).toBeGreaterThan(0);
    expect(state.error).toBeNull();
  });

  it("creates a fresh empty vault", async () => {
    const store = createVaultStore(createMockTransport());
    await store.getState().createNew();
    expect(store.getState().vault?.name).toBe("New Vault");
    expect(store.getState().vault?.counts.notes).toBe(0);
  });

  it("a cancelled picker returns to no-vault without an error", async () => {
    const transport = createMockTransport();
    transport.openVaultPicker = () => Promise.resolve(null);
    const store = createVaultStore(transport);
    await store.getState().openFromPicker();
    expect(store.getState().status).toBe("no-vault");
    expect(store.getState().error).toBeNull();
  });

  it("surfaces open failures as cause-and-remedy copy, not a crash", async () => {
    const transport = createMockTransport();
    transport.openVaultPath = () =>
      Promise.reject(new LoamIpcError({ error: "unknown-vault", id: "missing" }));
    const store = createVaultStore(transport);
    await store.getState().openPath("/gone");
    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toContain("Couldn't open the vault");
  });
});
