/**
 * The stable setting registry (LOA-86, §3.12). Every rendered control binds
 * to one of these definitions; `id` values are STABLE public API (plugins,
 * docs, and sync reference them — renames are breaking). `scope` decides
 * the write target: `shared` → `.loam/settings.json` in the vault,
 * `device` → app-data only (never the vault).
 */

export type SettingScope = "shared" | "device";

export interface SettingSection {
  id: string;
  title: string;
}

/** §3.12 navigation, in order. */
export const SETTING_SECTIONS: SettingSection[] = [
  { id: "general", title: "General" },
  { id: "editor", title: "Editor" },
  { id: "files-links", title: "Files & Links" },
  { id: "appearance", title: "Appearance" },
  { id: "hotkeys", title: "Hotkeys" },
  { id: "daily-notes", title: "Daily notes" },
  { id: "templates", title: "Templates" },
  { id: "core-features", title: "Core features" },
  { id: "plugins", title: "Plugins" },
  { id: "about", title: "About" },
];

export type SettingValue = boolean | number | string;

export interface SettingDefinition {
  /** Stable `setting-id` (§3.12) — never renamed. */
  id: string;
  section: string;
  scope: SettingScope;
  label: string;
  description: string;
  control:
    | { kind: "switch"; default: boolean }
    | { kind: "segmented"; options: { value: string; label: string }[]; default: string }
    | { kind: "slider"; min: number; max: number; step: number; default: number };
}

/** The M1 P0 controls (General/Editor/Files & Links/Appearance). */
export const SETTINGS: SettingDefinition[] = [
  {
    id: "general.reopen-last-vault",
    section: "general",
    scope: "device",
    label: "Reopen last vault on launch",
    description: "Skip the first-run screen when a vault was open.",
    control: { kind: "switch", default: true },
  },
  {
    id: "editor.readable-line-length",
    section: "editor",
    scope: "shared",
    label: "Readable line length",
    description: "Cap the editor measure at 46rem.",
    control: { kind: "switch", default: true },
  },
  {
    id: "editor.spellcheck",
    section: "editor",
    scope: "shared",
    label: "Spell check",
    description: "Check spelling while writing.",
    control: { kind: "switch", default: true },
  },
  {
    id: "editor.font-size",
    section: "editor",
    scope: "device",
    label: "Editor font size",
    description: "Base size for note text on this device.",
    control: { kind: "slider", min: 12, max: 24, step: 1, default: 16 },
  },
  {
    id: "files.confirm-trash",
    section: "files-links",
    scope: "shared",
    label: "Confirm before moving to trash",
    description: "Ask before a note leaves the vault.",
    control: { kind: "switch", default: true },
  },
  {
    id: "files.new-note-location",
    section: "files-links",
    scope: "shared",
    label: "New note location",
    description: "Where notes created from links land.",
    control: {
      kind: "segmented",
      options: [
        { value: "vault-root", label: "Vault root" },
        { value: "same-folder", label: "Same folder" },
      ],
      default: "vault-root",
    },
  },
  {
    id: "appearance.theme",
    section: "appearance",
    scope: "device",
    label: "Theme",
    description: "Loam Dark is the default; system follows the OS.",
    control: {
      kind: "segmented",
      options: [
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" },
        { value: "system", label: "System" },
      ],
      default: "dark",
    },
  },
  {
    id: "appearance.reduced-motion",
    section: "appearance",
    scope: "device",
    label: "Reduce motion",
    description: "Collapse all motion to quick fades.",
    control: {
      kind: "segmented",
      options: [
        { value: "system", label: "Match system" },
        { value: "reduced", label: "Always reduce" },
      ],
      default: "system",
    },
  },
];

export function settingById(id: string): SettingDefinition | undefined {
  return SETTINGS.find((setting) => setting.id === id);
}

export function defaultValueOf(setting: SettingDefinition): SettingValue {
  return setting.control.default;
}
