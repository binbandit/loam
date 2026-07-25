/** LOA-88: the §5.6 large-note policy against the real 2 MB demo fixture. */

import { expect, type Page, test } from "@playwright/test";

async function openVault(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("open-vault").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

test("a note at or below 2 MB opens with no notice (AC1)", async ({ page }) => {
  await openVault(page);
  await page.getByTestId("file-tree-body").getByText("Ideas", { exact: true }).click();
  await expect(page.getByTestId("editor")).toContainText("Capture anything");
  await expect(page.getByTestId("size-notice")).toHaveCount(0);
});

test("a note above 2 MB opens in Source with a dismissible notice (AC2)", async ({ page }) => {
  await openVault(page);
  await page.getByTestId("file-tree-body").getByText("Large note", { exact: true }).click();

  const notice = page.getByTestId("size-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Source mode");
  // Announced, not blocking: the note is open and its text is right there.
  await expect(notice).toHaveAttribute("role", "status");
  await expect(page.getByTestId("editor")).toContainText("deliberately oversized");

  // AC4: an oversized note is still fully editable.
  await page.locator(".cm-content").click();
  await page.keyboard.type("edited");
  const tab = page.getByRole("tab", { name: /Large note/ });
  await expect(tab).toContainText("unsaved changes");

  await notice.getByRole("button", { name: "Dismiss notice" }).click();
  await expect(notice).toHaveCount(0);
  // Dismissing changes nothing about the note itself.
  await expect(page.getByTestId("editor")).toContainText("deliberately oversized");
});
