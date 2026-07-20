/**
 * Theme selection (§4.2): `dark` (default), `light`, or `system` — system
 * follows `prefers-color-scheme` live. The choice lands as `data-theme` on
 * `<html>`, which is the only switch the token sheet reads.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export interface ThemeContextValue {
  /** The user's selection (may be `system`). */
  mode: ThemeMode;
  /** What is actually applied right now. */
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const QUERY = "(prefers-color-scheme: light)";

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia(QUERY).matches ? "light" : "dark";
}

function resolve(mode: ThemeMode): ResolvedTheme {
  return mode === "system" ? systemTheme() : mode;
}

export interface ThemeProviderProps {
  children: ReactNode;
  /** Initial mode; `dark` is the product default (§4.2). */
  defaultMode?: ThemeMode;
  /** Persistence hook (device-local settings land in E13). */
  onModeChange?: (mode: ThemeMode) => void;
}

export function ThemeProvider({
  children,
  defaultMode = "dark",
  onModeChange,
}: ThemeProviderProps): ReactNode {
  const [mode, setModeState] = useState<ThemeMode>(defaultMode);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(defaultMode));

  // Follow the OS while in system mode.
  useEffect(() => {
    if (mode !== "system" || typeof window.matchMedia !== "function") {
      setResolved(resolve(mode));
      return;
    }
    setResolved(systemTheme());
    const media = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setResolved(event.matches ? "light" : "dark");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode]);

  // The single application point for the token sheet.
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setMode = useCallback(
    (next: ThemeMode) => {
      setModeState(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme requires a <ThemeProvider> ancestor");
  }
  return context;
}
