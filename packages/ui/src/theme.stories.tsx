/** Stories for the theme provider (LOA-29/LOA-53). */

import { Button } from "./components/button";
import { ThemeProvider, useTheme } from "./theme";

export default { title: "Primitives / Theme" };

function Switcher() {
  const { mode, resolved, setMode } = useTheme();
  return (
    <div style={{ display: "flex", gap: "var(--loam-space-8)", alignItems: "center" }}>
      <Button variant={mode === "dark" ? "primary" : "secondary"} onClick={() => setMode("dark")}>
        Loam Dark
      </Button>
      <Button variant={mode === "light" ? "primary" : "secondary"} onClick={() => setMode("light")}>
        Loam Light
      </Button>
      <Button
        variant={mode === "system" ? "primary" : "secondary"}
        onClick={() => setMode("system")}
      >
        Match system
      </Button>
      <span style={{ color: "var(--loam-text-secondary)" }}>
        mode: {mode} · applied: {resolved}
      </span>
    </div>
  );
}

export function ThemeSwitcher() {
  return (
    <ThemeProvider>
      <Switcher />
    </ThemeProvider>
  );
}
