/**
 * Settings store (LOA-86, §3.12, D2). Values route strictly by scope:
 * shared → `.loam/settings.json` in the vault (atomic, hash-guarded
 * `note_write`), device → device storage only. A shared write can never
 * touch device state and vice versa (AC3) — the two paths share no code.
 */

import type { IpcTransport } from "@loam-app/ipc-client";
import { create } from "zustand";
import { defaultValueOf, SETTINGS, type SettingValue, settingById } from "../settings/registry";
import { deviceStorage } from "./device-storage";

const SHARED_FILE = ".loam/settings.json";

export interface SettingsState {
  values: Record<string, SettingValue>;
  /** Hash of the shared file for conflict-safe writes (§5.4). */
  sharedHash: string | null;
  error: string | null;
  load(vaultId: string): Promise<void>;
  set(id: string, value: SettingValue): Promise<void>;
}

function deviceKey(vaultId: string): string {
  return `loam.settings.${vaultId}`;
}

function defaults(): Record<string, SettingValue> {
  return Object.fromEntries(SETTINGS.map((setting) => [setting.id, defaultValueOf(setting)]));
}

export function createSettingsStore(transport: IpcTransport) {
  let vaultId: string | null = null;

  return create<SettingsState>()((set, get) => ({
    values: defaults(),
    sharedHash: null,
    error: null,

    async load(id) {
      vaultId = id;
      const values = defaults();
      // Device overrides.
      try {
        const raw = deviceStorage().getItem(deviceKey(id));
        if (raw) Object.assign(values, JSON.parse(raw));
      } catch {
        // Corrupt device overrides: defaults win.
      }
      // Shared file (missing file = defaults, §3.12).
      let sharedHash: string | null = null;
      try {
        const commands = await transport.getCommands();
        const result = await commands.noteRead(id, SHARED_FILE);
        if (result.status === "ok" && result.data.content) {
          sharedHash = result.data.hash;
          const shared = JSON.parse(result.data.content) as Record<string, SettingValue>;
          for (const [key, value] of Object.entries(shared)) {
            if (settingById(key)?.scope === "shared") values[key] = value;
          }
        }
      } catch {
        // Unreadable shared settings: defaults win; the next write recreates.
      }
      set({ values, sharedHash, error: null });
    },

    async set(id, value) {
      const setting = settingById(id);
      if (!setting || !vaultId) return;
      const values = { ...get().values, [id]: value };
      set({ values, error: null });

      if (setting.scope === "device") {
        // Device path: app-data only — the vault is never written (AC3).
        const deviceValues = Object.fromEntries(
          Object.entries(values).filter(([key]) => settingById(key)?.scope === "device"),
        );
        try {
          deviceStorage().setItem(deviceKey(vaultId), JSON.stringify(deviceValues));
        } catch {
          // Storage full: the in-memory value still applies this session.
        }
        return;
      }

      // Shared path: `.loam/settings.json` in the vault, hash-guarded.
      const shared = Object.fromEntries(
        Object.entries(values).filter(([key]) => settingById(key)?.scope === "shared"),
      );
      try {
        const commands = await transport.getCommands();
        const result = await commands.noteWrite(
          vaultId,
          SHARED_FILE,
          `${JSON.stringify(shared, null, 2)}\n`,
          get().sharedHash,
        );
        if (result.status === "error") {
          set({ error: `Couldn't save the setting: ${result.error.error.replace(/-/g, " ")}` });
          return;
        }
        set({ sharedHash: result.data.hash });
      } catch (error) {
        set({
          error: `Couldn't save the setting: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  }));
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;

/** Typed selector (D2). */
export const selectSettingValue =
  (id: string) =>
  (state: SettingsState): SettingValue | undefined =>
    state.values[id];
