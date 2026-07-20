/** LOA-66: first-run entries, shell landmarks, and keyboard order in a real browser. */

import { expect, test } from "@playwright/test";

test("first-run exposes exactly the three §4.4 entry paths (AC1)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("open-vault")).toHaveText("Open folder");
  await expect(page.getByTestId("create-vault")).toHaveText("Create new vault");
  await expect(page.getByTestId("drop-vault")).toContainText("Drag a folder");
  expect(await page.getByRole("button").count()).toBe(2);
});

test("opening the demo vault replaces first-run with the shell landmarks (AC2)", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("open-vault").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("first-run")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Files" })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByTestId("status-bar")).toContainText("Loam Demo");
  await expect(page.getByTestId("status-bar")).toContainText("Not indexed");
});

test("shell regions are keyboard reachable in logical order (AC4)", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("open-vault").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  // Tab from the top of the document: vault button (titlebar) → sidebar
  // resizer — chrome order matches the visual order left-to-right.
  const stops: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? (el.getAttribute("aria-label") ?? el.textContent?.slice(0, 24) ?? "") : "";
    });
    if (active) stops.push(active);
  }
  expect(stops.join(" | ")).toContain("Current vault");
  expect(stops.join(" | ")).toContain("Resize sidebar");
});

test("the sidebar resizer drags and collapses (E07 SplitPane wiring)", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("open-vault").click();
  const sidebar = page.getByTestId("left-sidebar");
  const before = (await sidebar.boundingBox())?.width ?? 0;
  const resizer = page.getByRole("separator", { name: "Resize sidebar" });
  await resizer.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const after = (await sidebar.boundingBox())?.width ?? 0;
  expect(after).toBe(before + 32);
});
