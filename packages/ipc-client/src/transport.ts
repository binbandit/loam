/**
 * IPC transport seam (LOA-21/LOA-48, typed by E06). The generated client
 * (`./generated/bindings`) is the full typed command surface; this seam
 * exists so the frontend never touches Tauri globals directly and can always
 * run in a plain browser (the complete in-memory mock lands with LOA-64).
 */

import type { LoamError, VaultInfo } from "./generated/bindings";

export interface IpcTransport {
  readonly kind: "native" | "mock";
  /** Liveness probe used by the shell's first paint. */
  ping(): Promise<string>;
  /** Open the native folder picker and open the chosen vault; null = cancelled. */
  openVaultPicker(): Promise<VaultInfo | null>;
}

/** True when running inside a Tauri webview. The only Tauri-global probe allowed. */
export function hasNativeShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Contract errors surface as thrown `LoamIpcError`s at the transport seam. */
export class LoamIpcError extends Error {
  constructor(readonly detail: LoamError) {
    super(detail.error);
    this.name = "LoamIpcError";
  }
}

export function createMockTransport(): IpcTransport {
  return {
    kind: "mock",
    ping: () => Promise.resolve("pong:mock"),
    openVaultPicker: () => Promise.resolve(null),
  };
}

function createNativeTransport(): IpcTransport {
  return {
    kind: "native",
    ping: () => Promise.resolve("pong:native"),
    openVaultPicker: async () => {
      const { commands } = await import("./generated/bindings");
      const result = await commands.vaultPickAndOpen();
      if (result.status === "error") {
        throw new LoamIpcError(result.error);
      }
      return result.data;
    },
  };
}

/** Native transport inside the shell, mock transport in any plain browser. */
export function createTransport(): IpcTransport {
  return hasNativeShell() ? createNativeTransport() : createMockTransport();
}
