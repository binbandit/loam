import { hasNativeShell } from "@loam-app/ipc-client";
import "./titlebar.css";

declare global {
  interface Window {
    /** Test seam: forces the platform branch in browser-driven tests. */
    __LOAM_PLATFORM_OVERRIDE__?: "macos" | "windows" | "linux";
  }
}

export function shellPlatform(): "macos" | "windows" | "linux" | "web" {
  if (typeof window !== "undefined" && window.__LOAM_PLATFORM_OVERRIDE__) {
    return window.__LOAM_PLATFORM_OVERRIDE__;
  }
  if (!hasNativeShell()) return "web";
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  return "linux";
}

export interface TitlebarProps {
  vaultName: string;
  /** Note breadcrumb slot; real data arrives with the app shell (E08). */
  breadcrumb?: string;
}

/**
 * Slim custom titlebar (§3.5): drag region, vault name, breadcrumb slot. On
 * macOS the native traffic lights overlay the reserved left inset; Windows and
 * Linux keep their native decorations above this bar.
 */
export function Titlebar({ vaultName, breadcrumb }: TitlebarProps) {
  return (
    <header className="titlebar" data-platform={shellPlatform()} data-tauri-drag-region>
      <button type="button" className="titlebar__vault" aria-label="Current vault">
        {vaultName}
      </button>
      <nav className="titlebar__breadcrumb" aria-label="Note breadcrumb">
        {breadcrumb ?? ""}
      </nav>
      <span className="titlebar__spacer" />
    </header>
  );
}
