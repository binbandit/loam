/**
 * LOA-90: the M1 editor quality gates that need a real browser — CJK IME
 * composition, Unicode grapheme handling, screen-reader announcements, and
 * keyboard-only operation at 150 % zoom.
 */

import { expect, type Page, test } from "@playwright/test";

async function openEditor(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("open-vault").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.getByTestId("file-tree-body").getByText("Ideas", { exact: true }).click();
  await page.waitForSelector(".cm-content");
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
}

function docText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector(".cm-content")?.textContent ?? "");
}

/** AC2: composition commits exactly the fixture text, with no leftovers. */
test("CJK IME composition commits the exact text (AC2)", async ({ page }) => {
  await openEditor(page);
  const cdp = await page.context().newCDPSession(page);

  // Japanese: romaji → kana → committed kanji, the classic three-stage IME.
  for (const stage of ["k", "か", "かん", "かんじ"]) {
    await cdp.send("Input.imeSetComposition", {
      text: stage,
      selectionStart: stage.length,
      selectionEnd: stage.length,
    });
  }
  await cdp.send("Input.insertText", { text: "漢字" });
  await expect.poll(() => docText(page)).toBe("漢字");

  // Korean jamo assembly commits one syllable, not the intermediate jamo.
  for (const stage of ["ㅎ", "하", "한"]) {
    await cdp.send("Input.imeSetComposition", {
      text: stage,
      selectionStart: stage.length,
      selectionEnd: stage.length,
    });
  }
  await cdp.send("Input.insertText", { text: "한글" });
  await expect.poll(() => docText(page)).toBe("漢字한글");

  // An abandoned composition leaves nothing behind.
  await cdp.send("Input.imeSetComposition", { text: "ちゅ", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  await expect.poll(() => docText(page)).toBe("漢字한글");
});

/** AC2: grapheme clusters move and delete as single units. */
test("Unicode grapheme clusters are one unit for the caret (AC2)", async ({ page }) => {
  await openEditor(page);
  const cdp = await page.context().newCDPSession(page);
  // Family emoji (ZWJ sequence), flag (regional indicators), combining accent.
  const fixture = "👨‍👩‍👧‍👦🇯🇵é";
  await cdp.send("Input.insertText", { text: fixture });
  await expect.poll(() => docText(page)).toBe(fixture);

  // One Backspace removes one grapheme, not one code unit.
  await page.keyboard.press("Backspace");
  await expect.poll(() => docText(page)).toBe("👨‍👩‍👧‍👦🇯🇵");
  await page.keyboard.press("Backspace");
  await expect.poll(() => docText(page)).toBe("👨‍👩‍👧‍👦");
  await page.keyboard.press("Backspace");
  await expect.poll(() => docText(page)).toBe("");
});

/** AC3: selection, fold, and search results reach the CM6 live region. */
test("screen readers hear selection, fold, and search results (AC3)", async ({ page }) => {
  await openEditor(page);
  await page.keyboard.type("cat dog cat");
  const announced = page.locator(".cm-announced");
  await expect(announced).toHaveAttribute("aria-live", "polite");

  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ControlOrMeta+d");
  await page.keyboard.press("ControlOrMeta+d");
  await expect(announced).toHaveText(/2 selections/);

  // Folding announces through the same region, from the gutter control.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("# Title\nbody line");
  await page.locator(".cm-gutters").hover();
  await page.getByRole("button", { name: "Fold section" }).first().click();
  await expect(announced).toHaveText(/Section folded/);
  await page.getByRole("button", { name: "Unfold section" }).click();
  await expect(announced).toHaveText(/Section unfolded/);

  // Find results are announced even though focus is in the panel.
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByRole("textbox", { name: "Find" }).fill("i");
  await page.getByRole("textbox", { name: "Find" }).press("Enter");
  await expect(announced).toHaveText(/Match \d+ of \d+/);
});

/**
 * AC4: keyboard-only operation at 150 % UI zoom. Zoom is modeled the way a
 * browser or OS scale factor actually applies it — fewer CSS pixels at a
 * higher device scale — not with `style.zoom`, which leaves `vh` units
 * measuring the unscaled viewport and invents clipping that never happens.
 */
test.describe("at 150% UI zoom", () => {
  test.use({ viewport: { width: 853, height: 533 }, deviceScaleFactor: 1.5 });

  test("keyboard flows work without clipped controls (AC4)", async ({ page }) => {
    await openEditor(page);
    await page.keyboard.type("zoomed line one");

    // Find, at zoom, entirely by keyboard.
    await page.keyboard.press("ControlOrMeta+f");
    const panel = page.getByTestId("find-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Find" })).toBeFocused();
    await page.keyboard.type("zoomed");
    await expect(page.getByTestId("find-count")).toHaveText(/1\/1/);

    // Nothing is clipped: every control, plus the status bar at the far edge,
    // is fully inside the viewport.
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("no viewport");
    const controls = [
      ...(await panel.getByRole("button").all()),
      page.getByTestId("status-bar"),
      page.getByRole("tab", { name: /Ideas/ }),
    ];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      if (!box) continue;
      expect(box.width).toBeGreaterThan(0);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    }

    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".cm-editor.cm-focused")).toBeVisible();
    // Editing still works at zoom.
    await page.keyboard.type("!");
    await expect(page.getByTestId("editor")).toContainText("zoomed line one!");
  });
});
