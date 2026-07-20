/**
 * Shared tab shape (LOA-75, §3.5). The lifecycle store lives in panes.ts
 * (LOA-76) — every pane hosts its own strip of these.
 */

export type ViewMode = "source" | "reading";

export interface Tab {
  /** Stable per-tab identity (multiple tabs may show one path later). */
  id: string;
  path: string;
  title: string;
  viewMode: ViewMode;
  dirty: boolean;
  missing: boolean;
}
