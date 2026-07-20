/**
 * Vault domain store (LOA-66, D2: separate Zustand stores). Talks to the
 * filesystem only through the injected `IpcTransport` — importing Tauri
 * APIs here is forbidden (enforced by stores/boundary.test.ts).
 */

import type { IpcTransport, VaultInfo } from "@loam-app/ipc-client";
import { create } from "zustand";

export type VaultStatus = "no-vault" | "opening" | "open" | "error";

export interface VaultState {
  status: VaultStatus;
  vault: VaultInfo | null;
  /** §4.5: errors state cause + remedy; null when healthy. */
  error: string | null;
  openFromPicker(): Promise<void>;
  openPath(path: string): Promise<void>;
  createNew(): Promise<void>;
}

async function runOpen(
  set: (partial: Partial<VaultState>) => void,
  open: () => Promise<VaultInfo | null>,
): Promise<void> {
  set({ status: "opening", error: null });
  try {
    const vault = await open();
    if (vault === null) {
      // Picker cancelled: back to where we were, silently (§4.5: no filler).
      set({ status: "no-vault" });
      return;
    }
    set({ status: "open", vault, error: null });
  } catch (error) {
    set({
      status: "error",
      error: `Couldn't open the vault: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export function createVaultStore(transport: IpcTransport) {
  return create<VaultState>()((set) => ({
    status: "no-vault",
    vault: null,
    error: null,
    openFromPicker: () => runOpen(set, () => transport.openVaultPicker()),
    openPath: (path) => runOpen(set, () => transport.openVaultPath(path)),
    createNew: () => runOpen(set, () => transport.createVault()),
  }));
}

export type VaultStore = ReturnType<typeof createVaultStore>;

/** Typed selectors (D2). */
export const selectVault = (state: VaultState): VaultInfo | null => state.vault;
export const selectVaultStatus = (state: VaultState): VaultStatus => state.status;
export const selectVaultError = (state: VaultState): string | null => state.error;
