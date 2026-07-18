/**
 * Minimal IPC transport seam (LOA-21). The generated typed client and the full
 * browser mock land with E06; the shape here only guarantees that the frontend
 * never touches Tauri globals directly and can always run in a plain browser.
 */
export interface IpcTransport {
  readonly kind: "native" | "mock";
  /** Liveness probe used by the shell's first paint. */
  ping(): Promise<string>;
}

/** True when running inside a Tauri webview. The only Tauri-global probe allowed. */
export function hasNativeShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createMockTransport(): IpcTransport {
  return {
    kind: "mock",
    ping: () => Promise.resolve("pong:mock"),
  };
}

function createNativeTransport(): IpcTransport {
  return {
    kind: "native",
    ping: () => Promise.resolve("pong:native"),
  };
}

/** Native transport inside the shell, mock transport in any plain browser. */
export function createTransport(): IpcTransport {
  return hasNativeShell() ? createNativeTransport() : createMockTransport();
}
