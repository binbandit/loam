/**
 * Typed vault event subscriptions (§5.4, LOA-60/LOA-63). Channel names and
 * payload shapes mirror `loam-core::ipc` exactly; payloads arrive wrapped in
 * the `EventEnvelope` (per-vault monotonic `seq` + originating `vaultId`).
 *
 * Consumer rules (see docs/search-switcher.md for the general pattern):
 * - Events are delivered per vault window by the shell; `vaultId` is
 *   defense-in-depth — drop envelopes for vaults you did not open.
 * - `seq` is monotonic per vault; a gap or regression indicates a bug and
 *   should be reported, not silently tolerated.
 */

import type {
  ConflictPayload,
  EventEnvelope,
  IndexProgress,
  VaultEvent,
} from "./generated/bindings";

export const EVENT_FILE_CHANGED = "vault://file-changed";
export const EVENT_INDEX_PROGRESS = "vault://index-progress";
export const EVENT_CONFLICT = "vault://conflict";

export type Unsubscribe = () => void;

async function subscribe<T>(
  channel: string,
  handler: (envelope: EventEnvelope<T>) => void,
): Promise<Unsubscribe> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<EventEnvelope<T>>(channel, (event) => handler(event.payload));
}

/** `vault://file-changed{path,kind,origin}` — normalized watcher + app writes. */
export function onFileChanged(
  handler: (envelope: EventEnvelope<VaultEvent>) => void,
): Promise<Unsubscribe> {
  return subscribe(EVENT_FILE_CHANGED, handler);
}

/** `vault://index-progress{done,total}` — monotonic during (re)indexing. */
export function onIndexProgress(
  handler: (envelope: EventEnvelope<IndexProgress>) => void,
): Promise<Unsubscribe> {
  return subscribe(EVENT_INDEX_PROGRESS, handler);
}

/** `vault://conflict{path,…}` — dirty-buffer external edit (§5.6 merge banner). */
export function onConflict(
  handler: (envelope: EventEnvelope<ConflictPayload>) => void,
): Promise<Unsubscribe> {
  return subscribe(EVENT_CONFLICT, handler);
}
