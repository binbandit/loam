/**
 * Story-host preference toolbar (LOA-53): toggles the reduced-motion and
 * reduced-transparency collapses in stories via the token sheet's
 * attribute-driven overrides (`data-motion` / `data-transparency` on
 * `<html>`). The Ladle provider wraps every story with this.
 */

import { type ReactNode, useEffect, useState } from "react";
import "../components/controls.css";

export interface StoryPreferencesState {
  reducedMotion: boolean;
  reducedTransparency: boolean;
}

/** Stamps preference attributes the token sheet reads. */
export function applyStoryPreferences(root: HTMLElement, prefs: StoryPreferencesState): void {
  if (prefs.reducedMotion) {
    root.dataset.motion = "reduced";
  } else {
    delete root.dataset.motion;
  }
  if (prefs.reducedTransparency) {
    root.dataset.transparency = "reduced";
  } else {
    delete root.dataset.transparency;
  }
}

export function StoryPreferences({ children }: { children: ReactNode }): ReactNode {
  const [prefs, setPrefs] = useState<StoryPreferencesState>({
    reducedMotion: false,
    reducedTransparency: false,
  });

  useEffect(() => {
    applyStoryPreferences(document.documentElement, prefs);
  }, [prefs]);

  // Snapshot captures use Ladle's preview mode; keep them chrome-free.
  const preview =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("mode") === "preview";
  if (preview) return children;

  return (
    <>
      {children}
      <div
        // Top-right of the canvas: clear of Ladle's bottom action strip.
        style={{
          position: "fixed",
          top: "var(--loam-space-8)",
          right: "var(--loam-space-8)",
          display: "flex",
          gap: "var(--loam-space-6)",
          zIndex: 10,
        }}
      >
        <button
          type="button"
          className="loam-button"
          data-variant={prefs.reducedMotion ? "primary" : "secondary"}
          aria-pressed={prefs.reducedMotion}
          onClick={() => setPrefs((prev) => ({ ...prev, reducedMotion: !prev.reducedMotion }))}
        >
          Reduced motion
        </button>
        <button
          type="button"
          className="loam-button"
          data-variant={prefs.reducedTransparency ? "primary" : "secondary"}
          aria-pressed={prefs.reducedTransparency}
          onClick={() =>
            setPrefs((prev) => ({ ...prev, reducedTransparency: !prev.reducedTransparency }))
          }
        >
          Reduced transparency
        </button>
      </div>
    </>
  );
}
