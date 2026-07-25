/** LOA-85: multicursor, select-next, and folding in a real browser. */

import { expect, type Page, test } from "@playwright/test";

async function openEditor(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("open-vault").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.getByTestId("file-tree-body").getByText("Welcome to Loam", { exact: true }).click();
  await page.waitForSelector(".cm-content");
  await page.locator(".cm-content").click();
}

/** Replaces the note body with `text` (newlines become Enter presses). */
async function retype(page: Page, text: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
}

test("⌘D selects each occurrence, formats them all, and Escape collapses (AC2/AC5)", async ({
  page,
}) => {
  await openEditor(page);
  await retype(page, "cat dog cat");
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowRight");

  await page.keyboard.press("ControlOrMeta+d");
  await expect(page.locator(".cm-selectionBackground")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+d");
  await expect(page.locator(".cm-selectionBackground")).toHaveCount(2);
  await expect(page.locator(".cm-cursor")).toHaveCount(2);

  // AC5: a formatting command applies to every selection at once.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByTestId("editor")).toContainText("**cat** dog **cat**");

  // AC2: Escape predictably returns to a single selection.
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-cursor")).toHaveCount(1);
});

test("fold controls appear on hover, are labelled, and fold only the body (AC3/AC4)", async ({
  page,
}) => {
  await openEditor(page);
  await retype(page, "# Title\nintro\n## Section\nbody line\n");

  const content = page.locator(".cm-content");
  const before = await content.boundingBox();
  // Hidden while the pointer is elsewhere…
  await page.mouse.move(0, 0);
  await expect(page.getByRole("button", { name: "Fold section" }).first()).toHaveCSS(
    "opacity",
    "0",
  );
  await page.locator(".cm-gutters").hover();
  const foldSection = page.getByRole("button", { name: "Fold section" });
  await expect(foldSection.first()).toHaveCSS("opacity", "1");
  // …and revealing them never moves the text (the column is always reserved).
  expect(await content.boundingBox()).toEqual(before);

  // The "## Section" control is the second one; folding hides its body only.
  // Live Preview renders the heading, so its `##` marks are not in the text
  // (LOA-102) — the heading itself must survive the fold.
  await foldSection.nth(1).click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
  await expect(page.getByTestId("editor")).toContainText("Section");
  await expect(page.getByTestId("editor")).not.toContainText("body line");
  await expect(page.getByTestId("editor")).toContainText("intro");

  // AC4: the closed control names the inverse action and stays visible.
  const unfold = page.getByRole("button", { name: "Unfold section" });
  await expect(unfold).toHaveCount(1);
  await expect(unfold).toHaveCSS("opacity", "1");
  await unfold.click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(0);
  await expect(page.getByTestId("editor")).toContainText("body line");
});

test("fold controls are keyboard reachable and toggle with Enter (AC4)", async ({ page }) => {
  await openEditor(page);
  await retype(page, "# Title\nintro\n## Section\nbody line\n");
  const first = page.getByRole("button", { name: "Fold section" }).first();
  await first.focus();
  await expect(first).toBeFocused();
  // Focus alone reveals the control, without a pointer anywhere near it.
  await expect(first).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
});
