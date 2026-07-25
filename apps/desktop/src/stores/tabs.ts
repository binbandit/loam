/**
 * Shared tab shape (LOA-75, §3.5). The lifecycle store lives in panes.ts
 * (LOA-76) — every pane hosts its own strip of these.
 */

import type { SizePolicy } from "@loam-app/ipc-client";

export type ViewMode = "source" | "reading";

export interface Tab {
  /** Stable per-tab identity (multiple tabs may show one path later). */
  id: string;
  path: string;
  title: string;
  viewMode: ViewMode;
  dirty: boolean;
  missing: boolean;
  /** §5.6 classification from the last read; pins the mode (LOA-88). */
  sizePolicy: SizePolicy;
  /** Whether the large-note notice has been dismissed for this tab. */
  noticeDismissed: boolean;
}
