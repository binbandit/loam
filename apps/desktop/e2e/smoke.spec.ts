import { expect, test } from "@playwright/test";

test("the web app entry boots in a real browser with the mock transport", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Loam");
  await expect(page.locator("main h1")).toHaveText("Loam");
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  // Outside the shell the app must use the mock transport and no Tauri globals.
  await expect(page.locator("main")).toHaveAttribute("data-transport", "mock");
  const hasTauriGlobal = await page.evaluate(() =>
    Object.keys(window).some((key) => key.startsWith("__TAURI")),
  );
  expect(hasTauriGlobal).toBe(false);
  // First-run entry action (§4.4); in the browser the mock picker is a no-op.
  const openFolder = page.getByRole("button", { name: "Open folder" });
  await expect(openFolder).toBeVisible();
  await openFolder.click();
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
});
