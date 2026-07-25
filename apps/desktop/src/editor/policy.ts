/**
 * Large-note editing policy (LOA-88, §3.2/§5.6). The thresholds live in
 * loam-core — the UI never re-derives them; it reads the classification the
 * `NoteDoc` already carries and decides what the editor may do with it.
 */

import type { NoteMeta, SizePolicy } from "@loam-app/ipc-client";
import type { ViewMode } from "../stores/tabs";

/** Anything past the 2 MB line: decoration and rendering are off the table. */
export function isOversized(policy: SizePolicy): boolean {
  return policy !== "normal";
}

/**
 * The mode a tab may actually use. Oversized notes are pinned to Source, so
 * no toggle — today's Reading, E10's Live Preview — can enter a rendered
 * mode while the note is too big to decorate.
 */
export function effectiveViewMode(requested: ViewMode, policy: SizePolicy): ViewMode {
  return isOversized(policy) ? "source" : requested;
}

/**
 * Past 20 MB the file is never read into memory (`content` is null), so
 * there is nothing to edit — writing the empty buffer back would truncate
 * the file. Everything else stays editable unless the file is read-only.
 */
export function isEditable(meta: Pick<NoteMeta, "readOnly" | "sizePolicy">): boolean {
  return !meta.readOnly && meta.sizePolicy !== "metadata-only";
}

/** Binary units, matching how the thresholds are defined (2 MB = 2 MiB). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The notice text for an oversized note, or null when there is nothing to say. */
export function sizeNotice(meta: Pick<NoteMeta, "size" | "sizePolicy">): string | null {
  switch (meta.sizePolicy) {
    case "source-only":
      return `This note is ${formatSize(meta.size)}. It stays in Source mode so editing stays fast.`;
    case "metadata-only":
      return `This note is ${formatSize(meta.size)}, too large to open. Loam shows it read-only and leaves the file untouched.`;
    default:
      return null;
  }
}
