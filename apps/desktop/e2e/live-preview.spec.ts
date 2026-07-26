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

/** LOA-107 AC2/AC3/AC5: the rendered checkbox is the ⌘L transaction. */
test("task checkboxes toggle the source and undo restores it (AC2/AC5)", async ({ page }) => {
  const body = "- [ ] buy milk\n- [x] call Ada\n\n> a quoted line\n";
  await openNote(page, body);

  const boxes = page.locator("input.cm-loam-task");
  await expect(boxes).toHaveCount(2);
  // AC3: real checkboxes with state and names taken from the item text.
  await expect(boxes.first()).not.toBeChecked();
  await expect(boxes.first()).toHaveAttribute("aria-label", "buy milk");
  await expect(boxes.nth(1)).toBeChecked();

  await boxes.first().click();
  await expect(page.getByTestId("editor")).toContainText("buy milk");
  await expect(boxes.first()).toBeChecked();

  // AC5: one undo puts the exact source back.
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(boxes.first()).not.toBeChecked();

  // The quote renders through its border, with the `>` marker hidden.
  await expect(page.locator(".cm-loam-quote")).toHaveCount(1);
  await expect(page.getByTestId("editor")).toContainText("a quoted line");

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

/** LOA-110: fenced code blocks — highlighting, chip, and copy. */
test.describe("fenced code", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("known languages highlight, unknown ones stay plain but labelled (AC1/AC2)", async ({
    page,
  }) => {
    const body = [
      "```js",
      "const answer = 42;",
      "function ask() { return answer; }",
      "```",
      "",
      "```rustlang",
      "fn main() {}",
      "```",
      "",
      "tail line",
      "",
    ].join("\n");
    await openNote(page, body);

    await expect(page.locator(".cm-loam-fence-open")).toHaveCount(2);
    const chips = page.locator(".cm-loam-fence-lang");
    await expect(chips.first()).toHaveText("js");
    await expect(chips.nth(1)).toHaveText("rustlang");

    // AC1: the JavaScript grammar loads on demand and colours the block.
    const highlighted = page.locator(".cm-loam-fence span[class^='ͼ']");
    await expect.poll(async () => await highlighted.count()).toBeGreaterThan(0);

    // AC2: the unknown grammar renders its code as plain text, no crash.
    await expect(page.getByTestId("editor")).toContainText("fn main() {}");
  });

  test("the copy action copies the code without its fences (AC3)", async ({ page }) => {
    await openNote(page, "```js\nconst a = 1;\nconst b = 2;\n```\n\ntail\n");

    const copy = page.getByRole("button", { name: "Copy js code" });
    // Hover-revealed, like the fold chevrons.
    await page.locator(".cm-loam-fence-open").hover();
    await expect(copy).toHaveCSS("opacity", "1");
    await copy.click();
    await expect(copy).toHaveText("Copied");

    // Windows' clipboard rewrites LF as CRLF on the way through, so compare
    // the content rather than the platform's line endings.
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard.replace(/\r\n/g, "\n")).toBe("const a = 1;\nconst b = 2;");
  });

  test("fence markers return while the cursor is on their line (AC4)", async ({ page }) => {
    await openNote(page, "```js\nconst a = 1;\n```\n\ntail\n");
    const editor = page.getByTestId("editor");
    await expect(editor).not.toContainText("```");

    await page.getByText("const a = 1;").click();
    await page.keyboard.press("ArrowUp");
    await expect(editor).toContainText("```js");
  });
});

/** LOA-114: frontmatter renders as a read-only property table. */
test("frontmatter renders as a property table and reveals raw YAML (AC1/AC2/AC5)", async ({
  page,
}) => {
  const body = [
    "---",
    "title: Field Notes",
    "tags: [research, deep/nested]",
    "aliases:",
    "  - FN",
    '  - "Field Notes"',
    "---",
    "",
    "# Body starts here",
    "",
  ].join("\n");
  await openNote(page, body);

  const table = page.locator("table.cm-loam-props");
  await expect(table).toBeVisible();
  // AC5: real row headers, and a caption for screen readers.
  await expect(table.locator("caption")).toHaveText("Note properties");
  await expect(table.getByRole("rowheader", { name: "title" })).toBeVisible();
  await expect(table.getByRole("cell", { name: "Field Notes", exact: true })).toBeVisible();
  // AC4: list values keep their order.
  await expect(table.locator(".cm-loam-prop-chip")).toHaveText([
    "research",
    "deep/nested",
    "FN",
    "Field Notes",
  ]);
  // The YAML is not on screen while the table is.
  await expect(page.getByTestId("editor")).not.toContainText("tags: [research");

  // AC2: clicking into the block brings the raw YAML back for editing.
  await page.getByText("Body starts here").click();
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(page.getByTestId("editor")).toContainText("title: Field Notes");
  await expect(table).toHaveCount(0);

  // The file itself never changed.
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

/** AC3: unreadable YAML shows the banner over untouched source. */
test("malformed frontmatter shows the banner and keeps the YAML (AC3)", async ({ page }) => {
  await openNote(
    page,
    "---\ntitle: [unclosed bracket\ntags: still: not: valid: yaml\n---\n\nBody\n",
  );
  await expect(page.locator(".cm-loam-props-error")).toHaveText("Frontmatter could not be parsed");
  await expect(page.locator("table.cm-loam-props")).toHaveCount(0);
  await expect(page.getByTestId("editor")).toContainText("title: [unclosed bracket");
});
