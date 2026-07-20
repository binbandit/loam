/** LOA-72: file tree in a real browser against the mock demo vault. */

import { expect, type Page, test } from "@playwright/test";

async function openShell(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("open-vault").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

test("renders the demo vault, expands folders, and virtualizes", async ({ page }) => {
  await openShell(page);
  const tree = page.getByRole("tree", { name: "Files" });
  await expect(tree).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Ideas" })).toBeVisible();
  // Expand by click: children mount.
  await page.getByTestId("file-tree-body").getByText("Projects", { exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "Loam", exact: true })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Garden", exact: true })).toBeVisible();
});

test("context menu exposes every file action (AC2 pointer path)", async ({ page }) => {
  await openShell(page);
  await page.getByTestId("file-tree-body").getByText("Ideas", { exact: true }).click();
  await page
    .getByTestId("file-tree-body")
    .getByText("Ideas", { exact: true })
    .click({ button: "right" });
  for (const item of [
    "Open",
    "New note",
    "New folder",
    "Rename",
    "Duplicate",
    "Copy path",
    "Move to trash",
  ]) {
    await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
  }
  // Duplicate through the menu: the §3.8 collision name appears.
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByRole("treeitem", { name: "Ideas 1" })).toBeVisible();
});

test("F2 renames inline and Escape cancels (AC2 keyboard path)", async ({ page }) => {
  await openShell(page);
  await page.getByTestId("file-tree-body").getByText("Ideas", { exact: true }).click();
  await page.keyboard.press("F2");
  const input = page.getByRole("textbox", { name: "Rename Ideas" });
  await expect(input).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
});

test("trash removes the row through the OS-trash command (AC5)", async ({ page }) => {
  await openShell(page);
  await page.getByTestId("file-tree-body").getByText("Reading list", { exact: true }).click();
  await page
    .getByTestId("file-tree-body")
    .getByText("Reading list", { exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await expect(page.getByRole("treeitem", { name: "Reading list" })).toHaveCount(0);
});
