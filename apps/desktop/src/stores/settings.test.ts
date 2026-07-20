/** LOA-86: setting registry and scope-routed persistence. */

import { createMockTransport, MOCK_DEMO_VAULT_PATH } from "@loam-app/ipc-client";
import { describe, expect, it } from "vitest";
import { SETTINGS, settingById } from "../settings/registry";
import { createSettingsStore } from "./settings";

const SHARED_FILE = ".loam/settings.json";

async function openStore() {
  const transport = createMockTransport();
  const vault = await transport.openVaultPath(MOCK_DEMO_VAULT_PATH);
  const store = createSettingsStore(transport);
  await store.getState().load(vault.id);
  return { transport, vault, store };
}

describe("setting registry", () => {
  it("every setting has a unique stable id and a known section (AC1)", () => {
    const ids = SETTINGS.map((setting) => setting.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const setting of SETTINGS) {
      expect(setting.id, setting.id).toMatch(/^[a-z-]+\.[a-z-]+$/);
      expect(["shared", "device"]).toContain(setting.scope);
    }
    // P0 sections are populated.
    for (const section of ["general", "editor", "files-links", "appearance"]) {
      expect(SETTINGS.some((setting) => setting.section === section)).toBe(true);
    }
  });
});

describe("scope routing (AC3)", () => {
  it("shared writes land in .loam/settings.json and never touch device state", async () => {
    const { transport, vault, store } = await openStore();
    await store.getState().set("editor.readable-line-length", false);
    const commands = await transport.getCommands();
    const file = await commands.noteRead(vault.id, SHARED_FILE);
    expect(file.status).toBe("ok");
    const shared = JSON.parse((file.status === "ok" && file.data.content) || "{}") as Record<
      string,
      unknown
    >;
    expect(shared["editor.readable-line-length"]).toBe(false);
    // Only shared-scope keys are in the vault file.
    for (const key of Object.keys(shared)) {
      expect(settingById(key)?.scope).toBe("shared");
    }
  });

  it("device writes never touch the vault", async () => {
    const { transport, vault, store } = await openStore();
    await store.getState().set("appearance.theme", "light");
    const commands = await transport.getCommands();
    const file = await commands.noteRead(vault.id, SHARED_FILE);
    // No shared write happened: the file still does not exist.
    expect(file.status).toBe("error");
    expect(store.getState().values["appearance.theme"]).toBe("light");
  });

  it("consecutive shared writes are hash-guarded (no conflict against self)", async () => {
    const { store } = await openStore();
    await store.getState().set("editor.spellcheck", false);
    await store.getState().set("files.confirm-trash", false);
    expect(store.getState().error).toBeNull();
    expect(store.getState().values["editor.spellcheck"]).toBe(false);
    expect(store.getState().values["files.confirm-trash"]).toBe(false);
  });

  it("device values restore per vault; shared values restore from the file", async () => {
    const transport = createMockTransport();
    const vault = await transport.openVaultPath(MOCK_DEMO_VAULT_PATH);
    const first = createSettingsStore(transport);
    await first.getState().load(vault.id);
    await first.getState().set("appearance.theme", "system");
    await first.getState().set("editor.spellcheck", false);

    const second = createSettingsStore(transport);
    await second.getState().load(vault.id);
    expect(second.getState().values["appearance.theme"]).toBe("system");
    expect(second.getState().values["editor.spellcheck"]).toBe(false);
    // Untouched settings keep their defaults.
    expect(second.getState().values["editor.readable-line-length"]).toBe(true);
  });
});
