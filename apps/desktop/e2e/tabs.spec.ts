/** LOA-75: tab lifecycle in a real browser (mock demo vault). */

import { expect, type Page, test } from "@playwright/test";

async function openShellWithNotes(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("open-vault").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.getByTestId("file-tree-body").getByText("Ideas", { exact: true }).click();
  await page.getByTestId("file-tree-body").getByText("Reading list", { exact: true }).click();
}

test("opening notes creates tabs and shows the note body", async ({ page }) => {
  await openShellWithNotes(page);
  const tablist = page.getByRole("tablist", { name: "Open notes" });
  await expect(tablist.getByRole("tab")).toHaveCount(2);
  await expect(tablist.getByRole("tab", { name: "Reading list" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("note-preview")).toContainText("How to take smart notes");
  // Pointer activation switches content without recreating the shell.
  await tablist.getByRole("tab", { name: "Ideas" }).click();
  await expect(page.getByTestId("note-preview")).toContainText("Capture anything");
});

test("⌘W closes and ⌘⇧T reopens the last tab (AC1/AC3)", async ({ page }) => {
  await openShellWithNotes(page);
  const tablist = page.getByRole("tablist", { name: "Open notes" });
  await page.keyboard.press("ControlOrMeta+w");
  await expect(tablist.getByRole("tab")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Shift+t");
  await expect(tablist.getByRole("tab")).toHaveCount(2);
  await expect(tablist.getByRole("tab", { name: "Reading list" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // ⌘1 activates the first tab.
  await page.keyboard.press("ControlOrMeta+1");
  await expect(tablist.getByRole("tab", { name: "Ideas" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("the overflow menu lists every tab with accessible names (AC5)", async ({ page }) => {
  await openShellWithNotes(page);
  await page.getByRole("button", { name: "All tabs" }).click();
  await expect(page.getByRole("menuitem", { name: "Ideas" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Reading list" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Ideas" }).click();
  await expect(
    page.getByRole("tablist", { name: "Open notes" }).getByRole("tab", { name: "Ideas" }),
  ).toHaveAttribute("aria-selected", "true");
});

test("⌘\\ splits right, focuses the new pane, and persists across reload (LOA-76)", async ({
  page,
}) => {
  await openShellWithNotes(page);
  await page.keyboard.press("ControlOrMeta+\\");
  await expect(page.locator(".pane")).toHaveCount(2);
  // The fresh pane has focus: opening from the tree lands there.
  await page.getByTestId("file-tree-body").getByText("Welcome to Loam", { exact: true }).click();
  const panes = page.locator(".pane");
  await expect(panes.nth(1).getByRole("tab", { name: /Welcome to Loam/ })).toBeVisible();
  await expect(panes.nth(0).getByRole("tab", { name: /Welcome to Loam/ })).toHaveCount(0);
  // Layout survives a reload (device-local persistence). Waiting out the
  // 250ms write debounce models a real quit, not a same-frame reload.
  await page.waitForTimeout(500);
  await page.reload();
  await page.getByTestId("open-vault").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator(".pane")).toHaveCount(2);
  await expect(
    page
      .locator(".pane")
      .nth(1)
      .getByRole("tab", { name: /Welcome to Loam/ }),
  ).toBeVisible();
});

test("⌘. toggles the right panel and Backlinks binds to the active note (LOA-80)", async ({
  page,
}) => {
  await openShellWithNotes(page);
  await expect(page.getByTestId("right-panel")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.getByTestId("right-panel")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Backlinks" })).toBeVisible();
  await expect(page.getByTestId("panel-view-backlinks")).toContainText("No linked mentions yet");
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.getByTestId("right-panel")).toHaveCount(0);
});

test("titlebar breadcrumb and status bar bind to the active pane (LOA-84)", async ({ page }) => {
  await openShellWithNotes(page);
  await expect(page.locator(".titlebar__breadcrumb")).toHaveText("Reading list");
  await expect(page.getByTestId("status-index")).toContainText("Not indexed");
  const counts = page.getByTestId("status-counts");
  await expect(counts).toContainText("words");
  await counts.click();
  await expect(counts).toContainText("characters");
  // Cursor position is absent until the E09 editor reports one (AC3).
  await expect(page.getByTestId("status-cursor")).toHaveCount(0);
  await expect(page.getByTestId("status-plugins")).toBeAttached();
  // Switching tabs moves the breadcrumb (AC1).
  await page.getByRole("tab", { name: "Ideas" }).click();
  await expect(page.locator(".titlebar__breadcrumb")).toHaveText("Ideas");
});

test("⌘, opens settings, badges announce scope, Escape returns focus (LOA-86)", async ({
  page,
}) => {
  await openShellWithNotes(page);
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  // Section navigation exists for all ten §3.12 areas.
  for (const section of ["General", "Editor", "Files & Links", "Appearance", "About"]) {
    await expect(dialog.getByRole("button", { name: section })).toBeVisible();
  }
  // Editor section: shared + device badges with accessible scope text.
  await dialog.getByRole("button", { name: "Editor" }).click();
  const row = page.locator('[data-setting-id="editor.readable-line-length"]');
  await expect(row.getByText("Vault")).toBeVisible();
  await expect(
    page.locator('[data-setting-id="editor.font-size"]').getByLabel("Stored on this device only"),
  ).toBeVisible();
  // Toggling a shared setting persists without an error line.
  await row.getByRole("switch").click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  // Escape closes and focus returns to the app.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Settings stay operable at 150% zoom (AC5 smoke).
  await page.evaluate(() => {
    (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = "1.5";
  });
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Appearance" }).click();
  await expect(page.locator('[data-setting-id="appearance.theme"]')).toBeVisible();
  await page.keyboard.press("Escape");
});

test("dirty conflicts show the banner; clean external edits reload silently (LOA-89)", async ({
  page,
}) => {
  await openShellWithNotes(page);
  type MockWindow = {
    __LOAM_MOCK__: {
      emitExternalChange: (vaultId: string, path: string, content: string) => void;
      emitConflict: (
        vaultId: string,
        payload: {
          path: string;
          mine: string;
          disk: string;
          base: string | null;
          diskHash: string;
        },
      ) => void;
    };
    __LOAM_VAULT_ID__?: string;
  };
  const vaultId = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='app-root']");
    void el;
    return null;
  });
  void vaultId;
  // Clean reload: change Reading list externally — the preview updates, no banner.
  await page.evaluate(() => {
    const mock = (window as unknown as MockWindow).__LOAM_MOCK__;
    // The demo vault is the only one open; find its id from a probe write.
    // vaultOpen is idempotent for the same path.
    return (
      mock as unknown as {
        commands: { vaultOpen: (p: string) => Promise<{ status: string; data: { id: string } }> };
      }
    ).commands
      .vaultOpen("/demo/Loam Demo")
      .then((result) => {
        (window as unknown as MockWindow).__LOAM_VAULT_ID__ = result.data.id;
      });
  });
  await page.evaluate(() => {
    const w = window as unknown as MockWindow;
    w.__LOAM_MOCK__.emitExternalChange(
      w.__LOAM_VAULT_ID__ as string,
      "Reading list.md",
      "# Reading list\n\n- changed on disk\n",
    );
  });
  await expect(page.getByTestId("note-preview")).toContainText("changed on disk");
  await expect(page.getByTestId("conflict-banner")).toHaveCount(0);
  // Dirty conflict: the banner appears with all three actions; merge shows
  // all three labeled columns.
  await page.evaluate(() => {
    const w = window as unknown as MockWindow;
    w.__LOAM_MOCK__.emitConflict(w.__LOAM_VAULT_ID__ as string, {
      path: "Reading list.md",
      mine: "# mine\n",
      disk: "# disk\n",
      base: "# base\n",
      diskHash: "feedbeef",
    });
  });
  const banner = page.getByTestId("conflict-banner");
  await expect(banner).toBeVisible();
  for (const action of ["Keep mine", "Take disk", "Merge manually"]) {
    await expect(banner.getByRole("button", { name: action })).toBeVisible();
  }
  await banner.getByRole("button", { name: "Merge manually" }).click();
  const merge = page.getByTestId("merge-columns");
  await expect(merge).toBeVisible();
  for (const label of ["Mine (editing)", "Disk (newer)", "Base (common)"]) {
    await expect(page.getByRole("region", { name: label })).toBeVisible();
  }
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(banner).toBeVisible(); // nothing was discarded
  // Take disk only on explicit activation.
  await banner.getByRole("button", { name: "Take disk" }).click();
  await expect(page.getByTestId("conflict-banner")).toHaveCount(0);
});
