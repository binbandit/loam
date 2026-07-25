/** LOA-102: headings and inline emphasis rendered in place, in a browser. */

import { expect, type Page, test } from "@playwright/test";

async function openNote(page: Page, body: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("open-vault").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.getByTestId("file-tree-body").getByText("Ideas", { exact: true }).click();
  await page.waitForSelector(".cm-content");
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document
      .querySelector(".cm-content")
      ?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
  }, body);
  // Park the cursor on the last line so nothing above it is revealed.
  await page.keyboard.press("ControlOrMeta+End");
}

const HEADINGS = ["# One", "## Two", "### Three", "#### Four", "##### Five", "###### Six", ""].join(
  "\n",
);

/** AC1: the computed type scale matches the §4.2 roles. */
test("H1–H6 render with the documented type roles (AC1)", async ({ page }) => {
  await openNote(page, HEADINGS);

  const roles = await page.evaluate(() =>
    [1, 2, 3, 4, 5, 6].map((level) => {
      const line = document.querySelector(`.cm-loam-h${level}`);
      if (!line) return null;
      const style = getComputedStyle(line);
      return {
        level,
        size: Number.parseFloat(style.fontSize),
        weight: Number.parseInt(style.fontWeight, 10),
        color: style.color,
      };
    }),
  );
  const measured = roles.filter((entry) => entry !== null);
  expect(measured).toHaveLength(6);
  const byLevel = new Map(measured.map((entry) => [entry.level, entry]));
  const role = (level: number) => {
    const entry = byLevel.get(level);
    if (!entry) throw new Error(`no rendered H${level}`);
    return entry;
  };

  // §4.2: H1 1.55em/650 · H2 1.30em/650 · H3 1.15em/600 · H4–H6 1.0em/600.
  const base = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.querySelector(".cm-content") as Element).fontSize),
  );
  expect(role(1).size).toBeCloseTo(base * 1.55, 0);
  expect(role(2).size).toBeCloseTo(base * 1.3, 0);
  expect(role(3).size).toBeCloseTo(base * 1.15, 0);
  for (const level of [4, 5, 6]) expect(role(level).size).toBeCloseTo(base, 0);
  expect([role(1).weight, role(2).weight]).toEqual([650, 650]);
  expect([3, 4, 5, 6].map((level) => role(level).weight)).toEqual([600, 600, 600, 600]);
  // H5 and H6 step down in color instead of size.
  expect(role(5).color).not.toBe(role(4).color);
  expect(role(6).color).not.toBe(role(5).color);

  // The marks themselves are gone from the rendered text.
  await expect(page.getByTestId("editor")).not.toContainText("#");
});

/** AC2/AC5: marks come back under the cursor and the file never changes. */
test("markers reveal on the cursor's line and the source is preserved (AC2/AC5)", async ({
  page,
}) => {
  const body = "Alpha **bold** and _italic_ and ~~struck~~ and `code`.\n\nBeta line.\n";
  await openNote(page, body);

  const editor = page.getByTestId("editor");
  await expect(editor).toContainText("Alpha bold and italic and struck and code.");
  await expect(editor).not.toContainText("**bold**");

  // Click into the first line: its raw markers come back, the rest stay rendered.
  await page.getByText("Alpha", { exact: false }).first().click();
  await expect(editor).toContainText("**bold**");
  await expect(editor).toContainText("~~struck~~");

  // Inline code is a styled span, not just recolored text.
  await expect(page.locator(".cm-loam-code").first()).toBeVisible();

  // AC5: what lands on disk is exactly what was typed.
  await page.keyboard.press("ControlOrMeta+s");
  const onDisk = await page.evaluate(async () => {
    const mock = (
      window as unknown as {
        __LOAM_MOCK__: {
          commands: {
            vaultOpen: (path: string) => Promise<{ data: { id: string } }>;
            noteRead: (vaultId: string, path: string) => Promise<{ data: { content: string } }>;
          };
        };
      }
    ).__LOAM_MOCK__;
    const vault = await mock.commands.vaultOpen("/demo/Loam Demo");
    const read = await mock.commands.noteRead(vault.data.id, "Ideas.md");
    return read.data.content;
  });
  expect(onDisk).toBe(body);
});

/** AC4: escaped markers stay literal characters. */
test("escaped markers are never emphasis (AC4)", async ({ page }) => {
  await openNote(page, "Literal \\*stars\\* and \\_underscores\\_ stay put.\n");
  const editor = page.getByTestId("editor");
  await expect(editor).toContainText("*stars*");
  await expect(editor).toContainText("_underscores_");
});
