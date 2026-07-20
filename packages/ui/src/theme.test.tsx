/** LOA-29: theme and system-theme selection hooks. */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./theme";

type Listener = (event: { matches: boolean }) => void;

function mockMatchMedia(initialLight: boolean): {
  setLight: (light: boolean) => void;
} {
  let matchesLight = initialLight;
  const listeners = new Set<Listener>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return query.includes("light") ? matchesLight : !matchesLight;
      },
      media: query,
      addEventListener: (_: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
    })),
  );
  return {
    setLight(light: boolean) {
      matchesLight = light;
      for (const listener of listeners) {
        listener({ matches: light });
      }
    },
  };
}

function Probe(): React.ReactNode {
  const { mode, resolved, setMode } = useTheme();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="resolved">{resolved}</span>
      <button type="button" onClick={() => setMode("light")}>
        light
      </button>
      <button type="button" onClick={() => setMode("system")}>
        system
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe("ThemeProvider", () => {
  it("defaults to dark and stamps data-theme on <html>", () => {
    mockMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("explicit selection switches the applied theme", () => {
    mockMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => {
      screen.getByText("light").click();
    });
    expect(screen.getByTestId("mode").textContent).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("system mode follows the OS live", () => {
    const media = mockMatchMedia(false);
    render(
      <ThemeProvider defaultMode="system">
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    act(() => {
      media.setLight(true);
    });
    expect(screen.getByTestId("resolved").textContent).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("reports mode changes to the persistence hook", () => {
    mockMatchMedia(false);
    const onModeChange = vi.fn();
    render(
      <ThemeProvider onModeChange={onModeChange}>
        <Probe />
      </ThemeProvider>,
    );
    act(() => {
      screen.getByText("system").click();
    });
    expect(onModeChange).toHaveBeenCalledWith("system");
  });
});
