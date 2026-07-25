/**
 * §5.6 size classification, mirroring `loam_core::vault::note::classify_size`
 * so the browser mock degrades exactly like the native reader does. Native
 * builds never call this — the real classification arrives on `NoteDoc`.
 */

import type { SizePolicy } from "./generated/bindings";

/** Above this a note is Source-mode only. */
export const SOURCE_ONLY_BYTES = 2 * 1024 * 1024;
/** Above this a note is never read into memory (metadata and hash only). */
export const METADATA_ONLY_BYTES = 20 * 1024 * 1024;

export function classifySize(size: number): SizePolicy {
  if (size > METADATA_ONLY_BYTES) return "metadata-only";
  if (size > SOURCE_ONLY_BYTES) return "source-only";
  return "normal";
}

/** Byte length of the UTF-8 encoding — what the native side reports. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
