/**
 * IPC transport seam (LOA-21/LOA-48, typed by E06). The generated client
 * (`./generated/bindings`) is the full typed command surface; this seam
 * exists so the frontend never touches Tauri globals directly and can always
 * run in a plain browser, where it is backed by the complete in-memory mock
 * (LOA-64) seeded with a demo vault.
 */

import type { Unsubscribe } from "./events";
import type {
  EventEnvelope,
  commands as GeneratedCommands,
  LoamError,
  VaultInfo,
} from "./generated/bindings";
import { createMockIpc, type MockIpc } from "./mock";

/** The full typed command surface (identical for native and mock). */
export type IpcCommands = typeof GeneratedCommands;

export interface IpcTransport {
  readonly kind: "native" | "mock";
  /** Liveness probe used by the shell's first paint. */
  ping(): Promise<string>;
  /** Open the native folder picker and open the chosen vault; null = cancelled. */
  openVaultPicker(): Promise<VaultInfo | null>;
  /** Open a vault from a known path (drag-a-folder entry, restored state). */
  openVaultPath(path: string): Promise<VaultInfo>;
  /**
   * First-run "Create new vault" (§4.4). Natively this routes through the
   * folder picker (a vault IS a folder — pick or create an empty one) until
   * a dedicated create command lands; the mock creates a fresh empty vault.
   */
  createVault(): Promise<VaultInfo | null>;
  /** The full typed command surface for feature stores (tree, notes, …). */
  getCommands(): Promise<IpcCommands>;
  /** Typed §5.4 event subscription (works on both backends). */
  listen<T>(channel: string, handler: (envelope: EventEnvelope<T>) => void): Promise<Unsubscribe>;
  /** Test/browser-demo seam: the underlying mock (undefined natively). */
  readonly mock?: MockIpc;
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

function unwrap<T>(result: { status: "ok"; data: T } | { status: "error"; error: LoamError }): T {
  if (result.status === "error") throw new LoamIpcError(result.error);
  return result.data;
}

/** Path the browser mock's demo vault is registered under. */
export const MOCK_DEMO_VAULT_PATH = "/demo/Loam Demo";
/** Path the browser mock uses for first-run "Create new vault". */
export const MOCK_NEW_VAULT_PATH = "/demo/New Vault";

const DEMO_FILES: Record<string, string> = {
  "Welcome to Loam.md":
    "# Welcome to Loam\n\nThis demo vault lives in the browser mock transport.\n\n- [[Ideas]]\n- [[Reading list]]\n",
  "Ideas.md": "# Ideas\n\nCapture anything. Link with [[Welcome to Loam]].\n",
  "Reading list.md": "# Reading list\n\n- How to take smart notes\n",
  "Projects/Loam.md": "# Loam\n\nLocal-first Markdown knowledge base.\n",
  "Projects/Garden.md": "# Garden\n\nPlant spring greens.\n",
};

export function createMockTransport(): IpcTransport {
  const mock = createMockIpc({
    vaults: {
      [MOCK_DEMO_VAULT_PATH]: { name: "Loam Demo", files: DEMO_FILES },
      [MOCK_NEW_VAULT_PATH]: { name: "New Vault", files: {} },
    },
  });
  return {
    kind: "mock",
    ping: () => Promise.resolve("pong:mock"),
    // Browsers have no folder picker; the demo vault stands in for a choice.
    openVaultPicker: async () => unwrap(await mock.commands.vaultOpen(MOCK_DEMO_VAULT_PATH)),
    openVaultPath: async (path) => unwrap(await mock.commands.vaultOpen(path)),
    createVault: async () => unwrap(await mock.commands.vaultOpen(MOCK_NEW_VAULT_PATH)),
    getCommands: () => Promise.resolve(mock.commands),
    listen: (channel, handler) => Promise.resolve(mock.listen(channel, handler)),
    mock,
  };
}

function createNativeTransport(): IpcTransport {
  const invoke = async <T>(
    run: (
      commands: typeof import("./generated/bindings").commands,
    ) => Promise<{ status: "ok"; data: T } | { status: "error"; error: LoamError }>,
  ): Promise<T> => {
    const { commands } = await import("./generated/bindings");
    return unwrap(await run(commands));
  };
  return {
    kind: "native",
    ping: () => Promise.resolve("pong:native"),
    openVaultPicker: () => invoke((commands) => commands.vaultPickAndOpen()),
    openVaultPath: (path) => invoke((commands) => commands.vaultOpen(path)),
    createVault: () => invoke((commands) => commands.vaultPickAndOpen()),
    getCommands: async () => (await import("./generated/bindings")).commands,
    listen: async (channel, handler) => {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<EventEnvelope<never>>(channel, (event) =>
        handler(event.payload as EventEnvelope<never>),
      );
    },
  };
}

/** Native transport inside the shell, mock transport in any plain browser. */
export function createTransport(): IpcTransport {
  return hasNativeShell() ? createNativeTransport() : createMockTransport();
}
