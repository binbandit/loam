/**
 * Ladle global provider (LOA-53): loads the token sheet + bundled fonts,
 * maps Ladle's theme switch onto `data-theme`, and mounts the
 * reduced-motion/reduced-transparency toolbar.
 */

import type { GlobalProvider } from "@ladle/react";
import { useEffect } from "react";
import { StoryPreferences } from "../src/stories-support/preferences";
import "../src/tokens/fonts.css";
import "../src/tokens/tokens.css";

export const Provider: GlobalProvider = ({ children, globalState }) => {
  useEffect(() => {
    // Ladle themes: light | dark | auto. Loam's default is dark.
    const resolved =
      globalState.theme === "light" ||
      (globalState.theme === "auto" && window.matchMedia("(prefers-color-scheme: light)").matches)
        ? "light"
        : "dark";
    document.documentElement.dataset.theme = resolved;
    document.body.style.background = "var(--loam-bg-app)";
    document.body.style.color = "var(--loam-text-primary)";
    document.body.style.fontFamily = "var(--loam-font-ui)";
    // Ladle's canvas paints its own background; stories sit on Loam's.
    if (!document.getElementById("loam-ladle-overrides")) {
      const style = document.createElement("style");
      style.id = "loam-ladle-overrides";
      style.textContent = ".ladle-main { background: var(--loam-bg-app) !important; }";
      document.head.appendChild(style);
    }
  }, [globalState.theme]);
  return <StoryPreferences>{children}</StoryPreferences>;
};
