/**
 * Per-device workspace persistence (LOA-91, §5.5). One versioned
 * `workspace.json` per vault in app-data (never the vault), written
 * atomically through IPC with trailing-debounced coalescing so rapid state
 * changes cost one write and never touch keystroke latency.
 *
 * The synchronous `deviceStorage` facade below is what the layout/tree/
 * panel/settings stores use as their storage seam — sections hydrate from
 * the file on vault open and every set schedules a flush.
 */

import type { IpcTransport } from "@loam-app/ipc-client";

export const WORKSPACE_VERSION = 1;
const FLUSH_DEBOUNCE_MS = 250;

interface WorkspaceFile {
  version: number;
  /** Section key → opaque JSON string owned by one store. */
  sections: Record<string, string>;
}

export interface DeviceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WorkspaceCoordinator {
  /** Hydrate from disk; quarantines corrupt files and falls back (AC3). */
  load(vaultId: string): Promise<void>;
  /** The storage facade feature stores persist through. */
  storage: DeviceStorage;
  /** Force the pending debounced write out (shutdown/tests). */
  flush(): Promise<void>;
  /** Test seam: pending write scheduled? */
  hasPendingWrite(): boolean;
}

export function createWorkspaceCoordinator(transport: IpcTransport): WorkspaceCoordinator {
  let vaultId: string | null = null;
  let sections: Record<string, string> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing = Promise.resolve();

  const writeNow = async (): Promise<void> => {
    if (!vaultId) return;
    const file: WorkspaceFile = { version: WORKSPACE_VERSION, sections };
    const commands = await transport.getCommands();
    await commands.workspaceWrite(vaultId, `${JSON.stringify(file, null, 2)}\n`);
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    // AC2: trailing debounce — rapid changes coalesce into one atomic write.
    timer = setTimeout(() => {
      timer = null;
      writing = writing.then(() =>
        writeNow().catch(() => {
          // Persistence is a nicety; the in-memory state stays authoritative.
        }),
      );
    }, FLUSH_DEBOUNCE_MS);
  };

  // Best-effort flush when the page/window goes away (the debounce window
  // is 250ms; a user quitting mid-window still usually lands the write).
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        void writeNow().catch(() => {});
      }
    });
  }

  return {
    async load(id) {
      vaultId = id;
      sections = {};
      try {
        const commands = await transport.getCommands();
        const result = await commands.workspaceRead(id);
        if (result.status !== "ok" || result.data === null) return;
        const parsed = JSON.parse(result.data) as WorkspaceFile;
        if (
          parsed.version !== WORKSPACE_VERSION ||
          typeof parsed.sections !== "object" ||
          parsed.sections === null
        ) {
          // Unsupported version with no migration path yet: quarantine.
          await commands.workspaceQuarantine(id);
          return;
        }
        sections = { ...parsed.sections };
      } catch {
        // Corrupt JSON: quarantine the bytes, fall back to defaults (AC3).
        try {
          const commands = await transport.getCommands();
          await commands.workspaceQuarantine(id);
        } catch {
          // Even quarantine failing must not block startup.
        }
      }
    },

    storage: {
      getItem: (key) => sections[key] ?? null,
      setItem: (key, value) => {
        sections[key] = value;
        schedule();
      },
    },

    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        writing = writing.then(() => writeNow().catch(() => {}));
      }
      await writing;
    },
    hasPendingWrite: () => timer !== null,
  };
}
