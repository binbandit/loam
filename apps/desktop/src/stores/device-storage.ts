/**
 * Device-storage seam (LOA-91). Feature stores persist through this facade;
 * once a vault opens it is backed by the per-device `workspace.json`
 * coordinator (app-data via IPC). Before hydration — and in tests — it
 * falls back to localStorage/memory so nothing breaks.
 */

import type { DeviceStorage } from "./workspace-file";

const memoryFallback = new Map<string, string>();

function fallbackStorage(): DeviceStorage {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // Blocked storage: memory below.
  }
  return {
    getItem: (key) => memoryFallback.get(key) ?? null,
    setItem: (key, value) => {
      memoryFallback.set(key, value);
    },
  };
}

let current: DeviceStorage | null = null;

/** Wired by the app once the workspace coordinator hydrated. */
export function setDeviceStorage(storage: DeviceStorage | null): void {
  current = storage;
}

export function deviceStorage(): DeviceStorage {
  return current ?? fallbackStorage();
}
