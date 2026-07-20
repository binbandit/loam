/** LOA-53: story coverage and the preference toolbar. */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { applyStoryPreferences, StoryPreferences } from "./preferences";

const srcRoot = resolve(__dirname, "..");

function collectFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(path, suffix));
    } else if (entry.name.endsWith(suffix)) {
      out.push(path);
    }
  }
  return out;
}

/** AC1: every exported PascalCase primitive appears in at least one story. */
describe("story coverage", () => {
  it("covers every exported component with a story", () => {
    const index = readFileSync(join(srcRoot, "index.ts"), "utf8");
    const exported = new Set<string>();
    for (const match of index.matchAll(/^export \{ ([^}]+) \}/gm)) {
      for (const name of (match[1] as string).split(",").map((part) => part.trim())) {
        // PascalCase components only (skip hooks, helpers, constants).
        if (/^[A-Z][a-z]/.test(name)) exported.add(name);
      }
    }
    expect(exported.size).toBeGreaterThan(20);

    const stories = collectFiles(srcRoot, ".stories.tsx")
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const missing = [...exported].filter(
      (name) => !new RegExp(`[<{.\\s]${name}[\\s.,>}]`).test(stories),
    );
    expect(missing, `primitives without stories: ${missing.join(", ")}`).toEqual([]);
  });
});

/** AC3: the toolbar toggles motion/transparency preferences in stories. */
describe("preference toolbar", () => {
  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.motion;
    delete document.documentElement.dataset.transparency;
  });

  it("toggles data-motion and data-transparency on <html>", async () => {
    const user = userEvent.setup();
    render(
      <StoryPreferences>
        <div>story</div>
      </StoryPreferences>,
    );
    const motion = screen.getByRole("button", { name: "Reduced motion" });
    await user.click(motion);
    expect(motion).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.dataset.motion).toBe("reduced");
    await user.click(screen.getByRole("button", { name: "Reduced transparency" }));
    expect(document.documentElement.dataset.transparency).toBe("reduced");
    await user.click(motion);
    expect(document.documentElement.dataset.motion).toBeUndefined();
  });

  it("token sheet defines the attribute-driven collapses the toolbar relies on", () => {
    const tokens = readFileSync(join(srcRoot, "tokens/tokens.css"), "utf8");
    expect(tokens).toContain(':root[data-motion="reduced"]');
    expect(tokens).toContain(':root[data-transparency="reduced"][data-theme="dark"]');
    expect(tokens).toContain(':root[data-transparency="reduced"][data-theme="light"]');
    applyStoryPreferences(document.documentElement, {
      reducedMotion: true,
      reducedTransparency: true,
    });
    expect(document.documentElement.dataset.motion).toBe("reduced");
    expect(document.documentElement.dataset.transparency).toBe("reduced");
    applyStoryPreferences(document.documentElement, {
      reducedMotion: false,
      reducedTransparency: false,
    });
    expect(document.documentElement.dataset.motion).toBeUndefined();
  });
});
