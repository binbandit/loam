/** LOA-29: the §4.2 token and typography system. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(__dirname, "../..");
const css = readFileSync(join(packageRoot, "src/tokens/tokens.css"), "utf8").replace(/\r\n/g, "\n");
const fontsCss = readFileSync(join(packageRoot, "src/tokens/fonts.css"), "utf8");

/** Extract `--token: value` pairs from the FIRST block matching the opener. */
function tokensOf(opener: string, source: string = css): Record<string, string> {
  const start = source.indexOf(opener);
  if (start < 0) throw new Error(`block not found: ${opener}`);
  const body = source.slice(start, source.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    out[match[1] as string] = (match[2] as string).replace(/\s*\/\*.*$/, "").trim();
  }
  return out;
}

/** Merge every NON-media block for a theme (colors + elevation). Media
 * overrides (reduced transparency) are intentionally excluded. */
function themeTokens(theme: "dark" | "light"): Record<string, string> {
  const opener = `:root[data-theme="${theme}"]`;
  const mediaStart = css.indexOf("@media (prefers-reduced-transparency");
  const scanned = mediaStart >= 0 ? css.slice(0, mediaStart) : css;
  let merged: Record<string, string> = {};
  let cursor = 0;
  while (true) {
    const at = scanned.indexOf(opener, cursor);
    if (at < 0) break;
    merged = { ...merged, ...tokensOf(opener, scanned.slice(at)) };
    cursor = at + opener.length;
  }
  return merged;
}

// ─── WCAG relative luminance ────────────────────────────────────────────────

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channel = (index: number): number => {
    const c = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(fg: string, bg: string): number {
  const [l1, l2] = [luminance(fg), luminance(bg)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe("§4.2 tokens", () => {
  /** AC1: the dark block byte-matches the normative SPEC values. */
  it("dark token values byte-match §4.2", () => {
    const spec: Record<string, string> = {
      "--loam-bg-app": "#0B0C0F",
      "--loam-bg-panel": "#101216",
      "--loam-bg-raised": "#16181D",
      "--loam-bg-overlay": "#1C1F26",
      "--loam-bg-hover": "rgba(255,255,255,0.045)",
      "--loam-bg-active": "rgba(255,255,255,0.08)",
      "--loam-bg-selected": "rgba(112,126,232,0.14)",
      "--loam-border-subtle": "rgba(255,255,255,0.06)",
      "--loam-border": "rgba(255,255,255,0.10)",
      "--loam-border-strong": "rgba(255,255,255,0.16)",
      "--loam-text-primary": "#EEEFF3",
      "--loam-text-secondary": "#9EA3AE",
      "--loam-text-tertiary": "#686E7A",
      "--loam-text-disabled": "#4A4F58",
      "--loam-accent": "#707EE8",
      "--loam-accent-hover": "#8590EE",
      "--loam-accent-text": "#A6AEF6",
      "--loam-accent-subtle": "rgba(112,126,232,0.14)",
      "--loam-success": "#3FB57F",
      "--loam-warning": "#D9A13C",
      "--loam-danger": "#E5544C",
      "--loam-highlight": "rgba(217,161,60,0.28)",
    };
    const dark = themeTokens("dark");
    for (const [token, value] of Object.entries(spec)) {
      expect(dark[token], token).toBe(value);
    }
  });

  /** AC2: the contrast walker — every text/background pair passes AA. */
  it("text/background pairs pass WCAG AA in both themes", () => {
    for (const theme of ["dark", "light"] as const) {
      const tokens = themeTokens(theme);
      const backgrounds = [
        tokens["--loam-bg-app"],
        tokens["--loam-bg-panel"],
        tokens["--loam-bg-raised"],
        tokens["--loam-bg-overlay"],
      ] as string[];
      const require = (token: string, floor: number): void => {
        const color = tokens[token];
        expect(color, token).toBeDefined();
        for (const bg of backgrounds) {
          const ratio = contrast(color as string, bg);
          expect(
            ratio,
            `${theme} ${token} on ${bg}: ${ratio.toFixed(2)}:1 (floor ${floor}:1)`,
          ).toBeGreaterThanOrEqual(floor);
        }
      };
      // Body text: 4.5:1. Large/secondary-UI: 3:1.
      require("--loam-text-primary", 4.5);
      require("--loam-text-secondary", 4.5);
      require("--loam-text-tertiary", 3);
      require("--loam-accent-text", 4.5);
      require("--loam-accent", 3);
      require("--loam-success", 3);
      require("--loam-warning", 3);
      require("--loam-danger", 3);
    }
  });

  /** AC3: bundled fonts ship with OFL notices; roles match the type table. */
  it("bundled fonts, licenses, and type roles match §4.2", () => {
    const fonts = [
      "InterVariable.woff2",
      "InterVariable-Italic.woff2",
      "JetBrainsMono-Regular.woff2",
      "JetBrainsMono-Italic.woff2",
      "JetBrainsMono-Medium.woff2",
      "JetBrainsMono-SemiBold.woff2",
      "JetBrainsMono-Bold.woff2",
      "SourceSerif4Variable-Roman.woff2",
      "SourceSerif4Variable-Italic.woff2",
    ];
    for (const font of fonts) {
      const path = join(packageRoot, "fonts", font);
      expect(existsSync(path), font).toBe(true);
      expect(statSync(path).size, font).toBeGreaterThan(10_000);
      expect(fontsCss, `@font-face for ${font}`).toContain(font);
    }
    for (const license of [
      "LICENSE-Inter.txt",
      "LICENSE-JetBrainsMono.txt",
      "LICENSE-SourceSerif4.md",
    ]) {
      const text = readFileSync(join(packageRoot, "fonts", license), "utf8");
      expect(text, license).toContain("SIL Open Font License");
    }

    // Font roles.
    const base = tokensOf(":root {");
    expect(base["--loam-font-ui"]).toContain("Inter");
    expect(base["--loam-font-mono"]).toContain("JetBrains Mono");
    expect(base["--loam-font-serif"]).toContain("Source Serif 4");

    // The §4.2 type table.
    const table: Array<[string, string, string, string]> = [
      ["micro", "11.5px", "16px", "500"],
      ["secondary", "12.5px", "18px", "450"],
      ["base", "13px", "20px", "450"],
      ["emphasis", "13px", "20px", "550"],
      ["title", "15px", "22px", "600"],
    ];
    for (const [role, size, line, weight] of table) {
      expect(base[`--loam-type-${role}-size`], role).toBe(size);
      expect(base[`--loam-type-${role}-line`], role).toBe(line);
      expect(base[`--loam-type-${role}-weight`], role).toBe(weight);
    }
    expect(base["--loam-type-editor-size"]).toBe("16px");
    expect(base["--loam-type-editor-line"]).toBe("1.65");
    expect(base["--loam-type-code-size"]).toBe("13.5px");
    expect(base["--loam-editor-measure"]).toBe("46rem");
    expect(base["--loam-type-h1-size"]).toBe("1.55em");
    expect(base["--loam-type-h2-size"]).toBe("1.30em");
  });

  /** AC4: reduced motion collapses everything to opacity at ≤ 80 ms. */
  it("reduced motion collapses durations to ≤80ms and zeroes transforms", () => {
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("/* Reduced transparency", start));
    for (const duration of ["--dur-fast", "--dur-base", "--dur-slow"]) {
      const match = block.match(new RegExp(`${duration}:\\s*(\\d+)ms`));
      expect(match, duration).not.toBeNull();
      expect(Number(match?.[1]), duration).toBeLessThanOrEqual(80);
    }
    expect(block).toContain("--loam-motion-translate: 0px");
    expect(block).toContain("--loam-motion-scale-from: 1");
  });

  /** Motion, spacing, radii, rows, and elevation match §4.2. */
  it("motion, spacing, radii, and elevation tokens match §4.2", () => {
    const base = tokensOf(":root {");
    expect(base["--dur-fast"]).toBe("100ms");
    expect(base["--dur-base"]).toBe("140ms");
    expect(base["--dur-slow"]).toBe("200ms");
    expect(base["--loam-ease"]).toBe("cubic-bezier(0.2, 0, 0, 1)");
    for (const step of [2, 4, 6, 8, 12, 16, 20, 24, 32, 40]) {
      expect(base[`--loam-space-${step}`]).toBe(`${step}px`);
    }
    expect(base["--loam-radius-input"]).toBe("4px");
    expect(base["--loam-radius-button"]).toBe("6px");
    expect(base["--loam-radius-popover"]).toBe("8px");
    expect(base["--loam-radius-modal"]).toBe("10px");
    expect(base["--loam-row-sidebar"]).toBe("28px");
    expect(base["--loam-row-menu"]).toBe("30px");
    expect(base["--loam-row-omnibar"]).toBe("40px");

    const dark = themeTokens("dark");
    expect(dark["--loam-shadow-popover"]).toBe("0 8px 24px rgba(0,0,0,0.42)");
    expect(dark["--loam-shadow-modal"]).toBe("0 16px 48px rgba(0,0,0,0.55)");
    expect(dark["--loam-scrim"]).toBe("rgba(0,0,0,0.5)");
    const light = themeTokens("light");
    expect(light["--loam-shadow-modal"]).toBe("0 16px 48px rgba(0,0,0,0.35)");
    expect(light["--loam-scrim"]).toBe("rgba(0,0,0,0.25)");
  });
});
