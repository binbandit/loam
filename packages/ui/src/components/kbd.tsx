/**
 * Kbd glyph (§4.3, LOA-45). Takes a platform-neutral combo ("Mod+Shift+K")
 * and renders the platform's labels: ⌘⇧K on macOS, Ctrl+Shift+K elsewhere.
 * The accessible name always spells the keys out in full.
 */

import type { ReactNode } from "react";
import { cx } from "./button";
import "./compact.css";

export type KbdPlatform = "mac" | "other";

export function detectPlatform(): KbdPlatform {
  if (typeof navigator === "undefined") return "other";
  return /mac|iphone|ipad/i.test(navigator.platform ?? "") ? "mac" : "other";
}

const MAC_GLYPHS: Record<string, string> = {
  mod: "⌘",
  meta: "⌘",
  cmd: "⌘",
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
};
const OTHER_LABELS: Record<string, string> = {
  mod: "Ctrl",
  meta: "Win",
  cmd: "Ctrl",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};
const SHARED_GLYPHS: Record<string, string> = {
  enter: "⏎",
  return: "⏎",
  backspace: "⌫",
  delete: "⌦",
  escape: "Esc",
  esc: "Esc",
  tab: "⇥",
  space: "␣",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};
const SPOKEN: Record<string, string> = {
  mod: "Command",
  meta: "Command",
  cmd: "Command",
  ctrl: "Control",
  control: "Control",
  alt: "Option",
  option: "Option",
  shift: "Shift",
  enter: "Enter",
  return: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  space: "Space",
  arrowup: "Up arrow",
  arrowdown: "Down arrow",
  arrowleft: "Left arrow",
  arrowright: "Right arrow",
};
const SPOKEN_OTHER: Record<string, string> = {
  ...SPOKEN,
  mod: "Control",
  cmd: "Control",
  meta: "Windows",
  alt: "Alt",
  option: "Alt",
};

/** Maps one key part to its visible label for the platform. */
export function keyLabel(part: string, platform: KbdPlatform): string {
  const key = part.toLowerCase();
  if (platform === "mac" && MAC_GLYPHS[key]) return MAC_GLYPHS[key];
  if (platform === "other" && OTHER_LABELS[key]) return OTHER_LABELS[key];
  if (SHARED_GLYPHS[key]) return SHARED_GLYPHS[key];
  return part.length === 1 ? part.toUpperCase() : part;
}

function spokenLabel(part: string, platform: KbdPlatform): string {
  const key = part.toLowerCase();
  const table = platform === "mac" ? SPOKEN : SPOKEN_OTHER;
  return table[key] ?? (part.length === 1 ? part.toUpperCase() : part);
}

export interface KbdProps {
  /** Platform-neutral combo, e.g. "Mod+Shift+K" or "Escape". */
  keys: string;
  /** Override the detected platform (used by tests and stories). */
  platform?: KbdPlatform;
  className?: string;
}

export function Kbd({ keys, platform = detectPlatform(), className }: KbdProps): ReactNode {
  const parts = keys.split("+").filter(Boolean);
  const spoken = parts.map((part) => spokenLabel(part, platform)).join(" ");
  const visible =
    platform === "mac"
      ? parts.map((part) => keyLabel(part, platform)).join("")
      : parts.map((part) => keyLabel(part, platform)).join("+");
  return (
    <kbd className={cx("loam-kbd", className)} aria-label={spoken}>
      {visible}
    </kbd>
  );
}
