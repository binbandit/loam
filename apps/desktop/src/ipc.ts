/**
 * The app's single transport instance (LOA-66). Everything filesystem-shaped
 * goes through `packages/ipc-client` — never Tauri globals — so the whole
 * frontend runs in a plain browser against the mock.
 */

import { createTransport, type IpcTransport } from "@loam-app/ipc-client";

export const ipc: IpcTransport = createTransport();
