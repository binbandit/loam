export type { Unsubscribe } from "./events";
export {
  EVENT_CONFLICT,
  EVENT_FILE_CHANGED,
  EVENT_INDEX_PROGRESS,
  onConflict,
  onFileChanged,
  onIndexProgress,
} from "./events";
export * from "./generated/bindings";
export type { MockCommands, MockIpc, MockIpcOptions } from "./mock";
export { createMockIpc } from "./mock";
export type { MockVaultFixture } from "./mock/store";
export { mockHash } from "./mock/store";
export type { IpcCommands, IpcTransport } from "./transport";
export {
  createMockTransport,
  createTransport,
  hasNativeShell,
  LoamIpcError,
  MOCK_DEMO_VAULT_PATH,
  MOCK_NEW_VAULT_PATH,
} from "./transport";
