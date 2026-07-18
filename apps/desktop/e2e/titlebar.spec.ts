import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// LOA-44 titlebar behavior in a real browser engine. Native window controls
// themselves (traffic lights, decorations) are platform chrome, verified by
// the LOA-49 native checklist.

test("hovering titlebar controls never shifts layout (AC5)", async ({ page }) => {
  await page.goto("/");
  const vault = page.locator(".titlebar__vault");
  const before = await vault.boundingBox();
  await vault.hover();
  await page.waitForTimeout(150); // longer than --dur-fast
  const after = await vault.boundingBox();
  expect(after).toEqual(before);
  const crumb = await page.locator(".titlebar__breadcrumb").boundingBox();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
  expect(await page.locator(".titlebar__breadcrumb").boundingBox()).toEqual(crumb);
});

test("macOS platform reserves the traffic-light inset (AC2)", async ({ page }) => {
  await page.addInitScript(() => {
    window.__LOAM_PLATFORM_OVERRIDE__ = "macos";
  });
  await page.goto("/");
  const bar = page.locator(".titlebar");
  await expect(bar).toHaveAttribute("data-platform", "macos");
  const paddingLeft = await bar.evaluate((el) => getComputedStyle(el).paddingLeft);
  expect(paddingLeft).toBe("78px");
});

test("web/non-mac platforms use the standard inset", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".titlebar");
  await expect(bar).toHaveAttribute("data-platform", "web");
  const paddingLeft = await bar.evaluate((el) => getComputedStyle(el).paddingLeft);
  expect(paddingLeft).toBe("12px");
});

test("titlebar background is fallback-first solid with progressive blur (AC4)", async ({
  page,
}) => {
  // Structural: the base rule sets the solid token background; translucency
  // appears only inside @supports, so engines without backdrop-filter render
  // the solid fallback by construction.
  const raw = readFileSync(resolve(import.meta.dirname, "../src/titlebar.css"), "utf8");
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, ""); // rules only, not prose
  const baseRule = css.indexOf("background: var(--loam-bg-panel)");
  const supportsBlock = css.indexOf("@supports");
  expect(baseRule).toBeGreaterThan(-1);
  expect(supportsBlock).toBeGreaterThan(baseRule);
  expect(css).toMatch(/@supports[^{]*backdrop-filter/);

  // Behavioral: in a supporting engine the bar is still visually opaque enough
  // to read (never fully transparent).
  await page.goto("/");
  const background = await page
    .locator(".titlebar")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
});

for (const scheme of ["dark", "light"] as const) {
  test(`titlebar renders in the ${scheme} theme (screenshot)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(() => {
      window.__LOAM_PLATFORM_OVERRIDE__ = "macos";
    });
    await page.goto("/");
    await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
    await page.screenshot({
      path: `test-results/titlebar-${scheme}.png`,
      clip: { x: 0, y: 0, width: 900, height: 120 },
    });
  });
}
