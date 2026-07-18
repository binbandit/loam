import { expect, test } from "@playwright/test";

test("the web app entry boots in a real browser", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Loam");
  await expect(page.locator("#root")).toHaveText("Loam");
  await expect(page.locator("#root")).toHaveAttribute("data-ready", "true");
});
