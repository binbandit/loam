/**
 * The complete browser mock (§5.12, LOA-64): implements the exact generated
 * command surface (`typeof commands` — adding a Rust command breaks this
 * file's compilation until the mock covers it) plus the §5.4 event channels
 * with native ordering semantics (per-vault monotonic `seq`, app-origin
 * write events, external events via the test helper).
 *
 * Every `createMockIpc()` call returns a fully isolated instance — no module
 * state — so parallel tests never interfere. `latencyMs` adds a controllable
 * delay so explicit latency tests are not masked by mock speed.
 */

import type {
  ConflictPayload,
  commands,
  EventEnvelope,
  IndexProgress,
  LoamError,
  TreeEntryDto,
  VaultEvent,
} from "../generated/bindings";

type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

import {
  EVENT_CONFLICT,
  EVENT_FILE_CHANGED,
  EVENT_INDEX_PROGRESS,
  type Unsubscribe,
} from "../events";
import { type MockVaultFixture, MockVaultStore, mockHash } from "./store";

export type MockCommands = typeof commands;

interface WorkspaceKv {
  get(vaultId: string): string | undefined;
  set(vaultId: string, content: string): void;
  remove(vaultId: string): void;
}
const memoryWorkspaces = new Map<string, string>();
function workspaceStore(): WorkspaceKv {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const ls = window.localStorage;
      return {
        get: (id) => ls.getItem(`loam-mock-workspace.${id}`) ?? undefined,
        set: (id, content) => ls.setItem(`loam-mock-workspace.${id}`, content),
        remove: (id) => ls.removeItem(`loam-mock-workspace.${id}`),
      };
    }
  } catch {
    // Blocked storage: memory below.
  }
  return {
    get: (id) => memoryWorkspaces.get(id),
    set: (id, content) => {
      memoryWorkspaces.set(id, content);
    },
    remove: (id) => {
      memoryWorkspaces.delete(id);
    },
  };
}

export interface MockIpcOptions {
  /** Pre-registered vault fixtures keyed by the path used to open them. */
  vaults?: Record<string, MockVaultFixture>;
  /** Artificial per-command latency (perf-test support). */
  latencyMs?: number;
}

type EnvelopeHandler = (envelope: EventEnvelope<unknown>) => void;

export interface MockIpc {
  /** Drop-in replacement for the generated `commands` object. */
  commands: MockCommands;
  /** Typed event subscription mirroring the native channels. */
  listen<T>(channel: string, handler: (envelope: EventEnvelope<T>) => void): Unsubscribe;
  /** Test helper: simulate an EXTERNAL file change (watcher-origin). */
  emitExternalChange(vaultId: string, path: string, content: string | null): void;
  /** Test helper: simulate index progress from the (mock) index pipeline. */
  emitIndexProgress(vaultId: string, progress: IndexProgress): void;
  /** Test helper: simulate a §5.6 conflict event. */
  emitConflict(vaultId: string, payload: ConflictPayload): void;
  /** All events emitted so far, in order (ordering-contract assertions). */
  emitted(): ReadonlyArray<{ channel: string; envelope: EventEnvelope<unknown> }>;
}

function ok<T>(data: T): Result<T, LoamError> {
  return { status: "ok", data };
}

function err<T>(error: LoamError): Result<T, LoamError> {
  return { status: "error", error };
}

// Instance numbering only — no data is shared between instances; this just
// keeps vault ids globally unique so cross-instance ids can never collide.
let instanceCounter = 0;

export function createMockIpc(options: MockIpcOptions = {}): MockIpc {
  instanceCounter += 1;
  const instance = instanceCounter;
  const vaultsByPath = new Map<string, MockVaultStore>();
  const vaultsById = new Map<string, MockVaultStore>();
  const listeners = new Map<string, Set<EnvelopeHandler>>();
  const sequences = new Map<string, number>();
  const log: Array<{ channel: string; envelope: EventEnvelope<unknown> }> = [];
  let nextVaultId = 0;

  const delay = async (): Promise<void> => {
    if (options.latencyMs && options.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    }
  };

  const emit = (vaultId: string, channel: string, payload: unknown): void => {
    const seq = sequences.get(vaultId) ?? 0;
    sequences.set(vaultId, seq + 1);
    const envelope: EventEnvelope<unknown> = { seq, vaultId, payload };
    log.push({ channel, envelope });
    for (const handler of listeners.get(channel) ?? []) {
      handler(envelope);
    }
  };

  const vault = (vaultId: string): MockVaultStore | LoamError => {
    const store = vaultsById.get(vaultId);
    return store ?? { error: "unknown-vault", id: vaultId };
  };

  const appFileChanged = (vaultId: string, path: string, kind: "created" | "modified"): void => {
    const payload: VaultEvent = { path, type: kind, origin: "app" };
    emit(vaultId, EVENT_FILE_CHANGED, payload);
  };

  const mockCommands: MockCommands = {
    async vaultOpen(path) {
      await delay();
      const existing = vaultsByPath.get(path);
      let store = existing;
      if (!store) {
        nextVaultId += 1;
        store = new MockVaultStore(
          `mock-${instance}-vault-${nextVaultId}`,
          options.vaults?.[path] ?? {},
        );
      }
      vaultsByPath.set(path, store);
      vaultsById.set(store.id, store);
      return ok({
        id: store.id,
        name: store.name,
        readOnly: store.readOnly,
        transientIdentity: store.readOnly,
        counts: store.counts(),
        indexStatus: "notIndexed" as const,
      });
    },

    async vaultPickAndOpen() {
      await delay();
      // Browsers have no native picker; UI flows drive vaultOpen directly.
      return ok(null);
    },

    async noteRead(vaultId, path) {
      await delay();
      const store = vault(vaultId);
      if (!(store instanceof MockVaultStore)) {
        return err(store);
      }
      const content = store.read(path);
      if (content === undefined) {
        return err({ error: "not-found", path });
      }
      return ok({
        path,
        content,
        hash: mockHash(content),
        meta: {
          size: content.length,
          modifiedMs: null,
          readOnly: store.readOnly,
          sizePolicy: "normal" as const,
          readMs: 0,
        },
      });
    },

    async noteWrite(vaultId, path, content, baseHash) {
      await delay();
      const store = vault(vaultId);
      if (!(store instanceof MockVaultStore)) {
        return err(store);
      }
      if (store.readOnly) {
        return err({ error: "read-only", path });
      }
      const existing = store.hashOf(path);
      if (baseHash === null) {
        // Native contract: base None is a CREATE; existing file = conflict
        // with AlreadyExists.
        if (existing !== undefined) {
          return err({ error: "already-exists", path });
        }
      } else if (existing === undefined) {
        return err({ error: "not-found", path });
      } else if (existing !== baseHash) {
        return err({ error: "conflict", path, diskHash: existing });
      }
      const hash = store.write(path, content);
      appFileChanged(vaultId, path, baseHash === null ? "created" : "modified");
      return ok({ path, hash });
    },

    async noteCreate(vaultId, folder, title) {
      await delay();
      const store = vault(vaultId);
      if (!(store instanceof MockVaultStore)) {
        return err(store);
      }
      const path = store.uniqueName(folder, title, "md");
      store.write(path, "");
      appFileChanged(vaultId, path, "created");
      return ok({ path, title });
    },

    async folderCreate(vaultId, parent, name) {
      await delay();
      const store = vault(vaultId);
      if (!(store instanceof MockVaultStore)) {
        return err(store);
      }
      // Folders are implicit in the store; return the collision-free path.
      return ok(store.uniqueName(parent, name, null));
    },

    async noteRename(vaultId, from, to) {
      await delay();
      const store = vault(vaultId);
      if (!(store instanceof MockVaultStore)) {
        return err(store);
      }
      if (!store.has(from)) {
        return err({ error: "not-found", path: from });
      }
      if (store.has(to)) {
        return err({ error: "already-exists", path: to });
      }
      store.rename(from, to);
      return ok(null);
    },

    async noteDuplicate(vaultId, path) {
      await delay();
      const store = vault(vaultId);
      if (!(store instanceof MockVaultStore)) {
        return err(store);
      }
      const content = store.read(path);
      if (content === undefined) {
        return err({ error: "not-found", path });
      }
      const stem = path.replace(/\.md$/, "");
      const copy = store.uniqueName("", stem.includes("/") ? stem : stem, "md");
      store.write(copy, content);
      appFileChanged(vaultId, copy, "created");
      const title = copy.split("/").at(-1)?.replace(/\.md$/, "") ?? copy;
      return ok({ path: copy, title });
    },

    async noteTrash(vaultId, path) {
      await delay();
      const store = vault(vaultId);
      if (!(store instanceof MockVaultStore)) {
        return err(store);
      }
      if (!store.remove(path)) {
        return err({ error: "not-found", path });
      }
      return ok(null);
    },

    async vaultTree(vaultId) {
      await delay();
      const store = vault(vaultId);
      if (!(store instanceof MockVaultStore)) {
        return err(store);
      }
      // Mirror native enumeration: flat entries sorted by logical path,
      // folders derived from file paths. Deterministic modified times keyed
      // by position keep sorting testable without wall clocks.
      const entries = new Map<string, TreeEntryDto>();
      const paths = store.paths();
      paths.forEach((path, index) => {
        const parts = path.split("/");
        for (let depth = 1; depth < parts.length; depth += 1) {
          const folder = parts.slice(0, depth).join("/");
          if (!entries.has(folder)) {
            entries.set(folder, {
              path: folder,
              name: parts[depth - 1] as string,
              kind: "folder",
              size: 0,
              modifiedMs: null,
            });
          }
        }
        const content = store.read(path) ?? "";
        entries.set(path, {
          path,
          name: parts.at(-1) as string,
          kind: path.toLowerCase().endsWith(".md") ? "markdown" : "other",
          size: content.length,
          modifiedMs: 1_700_000_000_000 + index * 60_000,
        });
      });
      return ok({ entries: [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1)) });
    },

    // Per-device workspace state (LOA-91): localStorage when available so
    // browser-demo reloads persist, otherwise instance memory.
    async workspaceRead(vaultId) {
      await delay();
      return ok(workspaceStore().get(vaultId) ?? null);
    },
    async workspaceWrite(vaultId, content) {
      await delay();
      workspaceStore().set(vaultId, content);
      return ok(null);
    },
    async workspaceQuarantine(vaultId) {
      await delay();
      const existing = workspaceStore().get(vaultId);
      if (existing !== undefined) {
        workspaceStore().set(`${vaultId}.corrupt`, existing);
        workspaceStore().remove(vaultId);
      }
      return ok(null);
    },
  };

  return {
    commands: mockCommands,
    listen<T>(channel: string, handler: (envelope: EventEnvelope<T>) => void): Unsubscribe {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler as EnvelopeHandler);
      listeners.set(channel, set);
      return () => {
        set.delete(handler as EnvelopeHandler);
      };
    },
    emitExternalChange(vaultId, path, content) {
      const store = vaultsById.get(vaultId);
      if (!store) {
        return;
      }
      let payload: VaultEvent;
      if (content === null) {
        store.remove(path);
        payload = { path, type: "deleted", origin: "external" };
      } else {
        const kind = store.has(path) ? "modified" : "created";
        store.write(path, content);
        payload = { path, type: kind, origin: "external" };
      }
      emit(vaultId, EVENT_FILE_CHANGED, payload);
    },
    emitIndexProgress(vaultId, progress) {
      emit(vaultId, EVENT_INDEX_PROGRESS, progress);
    },
    emitConflict(vaultId, payload) {
      emit(vaultId, EVENT_CONFLICT, payload);
    },
    emitted() {
      return log;
    },
  };
}
