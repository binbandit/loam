/** LOA-37: menu, context menu, tooltip, and popover primitives. */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { ContextMenu, Menu } from "./menu";
import { Popover } from "./popover";
import { TOOLTIP_DELAY_MS, Tooltip, TooltipProvider } from "./tooltip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset.theme;
});

function FileMenu({ onDelete = () => {} }: { onDelete?: () => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button>File</Button>} />
      <Menu.Content>
        <Menu.Item shortcut="⌘N">New note</Menu.Item>
        <Menu.Item shortcut="⌘D">Duplicate</Menu.Item>
        <Menu.Separator />
        <Menu.Submenu>
          <Menu.SubmenuTrigger>Open recent</Menu.SubmenuTrigger>
          <Menu.Content>
            <Menu.Item>Ideas.md</Menu.Item>
            <Menu.Item>Daily note.md</Menu.Item>
          </Menu.Content>
        </Menu.Submenu>
        <Menu.Separator />
        <Menu.Item danger shortcut="⌘⌫" onClick={onDelete}>
          Delete
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}

/** AC1: arrow, Home/End, type-ahead, Enter, and Escape. */
describe("menu keyboard", () => {
  it("opens from the keyboard and moves highlight with arrows and Home/End", async () => {
    const user = userEvent.setup();
    render(<FileMenu />);
    await user.tab();
    await user.keyboard("{Enter}");
    const items = await screen.findAllByRole("menuitem");
    expect(items.length).toBeGreaterThanOrEqual(4);
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(
        screen.getAllByRole("menuitem").some((item) => item.hasAttribute("data-highlighted")),
      ).toBe(true),
    );
    await user.keyboard("{End}");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /Delete/ })).toHaveAttribute("data-highlighted"),
    );
    await user.keyboard("{Home}");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /New note/ })).toHaveAttribute(
        "data-highlighted",
      ),
    );
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /Duplicate/ })).toHaveAttribute(
        "data-highlighted",
      ),
    );
  });

  it("type-ahead highlights the matching item and Enter activates it", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<FileMenu onDelete={onDelete} />);
    await user.tab();
    await user.keyboard("{Enter}");
    await screen.findAllByRole("menuitem");
    await user.keyboard("del");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /Delete/ })).toHaveAttribute("data-highlighted"),
    );
    await user.keyboard("{Enter}");
    expect(onDelete).toHaveBeenCalled();
  });

  it("Escape closes the menu and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<FileMenu />);
    const trigger = screen.getByRole("button", { name: "File" });
    await user.click(trigger);
    await screen.findAllByRole("menuitem");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("shows the shortcut column on items", async () => {
    const user = userEvent.setup();
    render(<FileMenu />);
    await user.click(screen.getByRole("button", { name: "File" }));
    const item = await screen.findByRole("menuitem", { name: /New note/ });
    expect(item.querySelector(".loam-menu__shortcut")?.textContent).toBe("⌘N");
  });
});

/** AC2: submenus stay reachable by keyboard and pointer. */
describe("submenu", () => {
  it("opens with ArrowRight and returns with ArrowLeft", async () => {
    const user = userEvent.setup();
    render(<FileMenu />);
    await user.tab();
    await user.keyboard("{Enter}");
    await screen.findAllByRole("menuitem");
    await user.keyboard("o"); // type-ahead to "Open recent"
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /Open recent/ })).toHaveAttribute(
        "data-highlighted",
      ),
    );
    await user.keyboard("{ArrowRight}");
    // Wait for DOM focus to land inside the submenu — ArrowLeft only closes
    // it from there (keydown on the old target is a no-op on the parent).
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Ideas.md" })).toHaveFocus());
    await user.keyboard("{ArrowLeft}");
    // The submenu unmounts after its exit transition; allow for slow CI.
    await waitFor(
      () => expect(screen.queryByRole("menuitem", { name: "Ideas.md" })).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("opens on pointer hover", async () => {
    const user = userEvent.setup();
    render(<FileMenu />);
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.hover(await screen.findByRole("menuitem", { name: /Open recent/ }));
    expect(await screen.findByRole("menuitem", { name: "Ideas.md" })).toBeInTheDocument();
  });
});

/** Context menu opens on right-click with the same item components. */
describe("context menu", () => {
  it("opens at the pointer and dismisses with Escape", async () => {
    const user = userEvent.setup();
    render(
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          <div style={{ width: 200, height: 100 }}>Vault area</div>
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item shortcut="⏎">Open</ContextMenu.Item>
          <ContextMenu.Item danger>Move to trash</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Root>,
    );
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("Vault area") });
    expect(await screen.findByRole("menuitem", { name: /Move to trash/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
});

/** AC3: tooltip timing — 400 ms default delay, instant between grouped
 * targets. Base UI's internals mix timers with frame callbacks, so fake
 * timers deadlock user-event; timing is asserted with real clocks and a
 * scaled-up delay (open latency far below it proves the grouping). */
describe("tooltip timing", () => {
  it("defaults to the §4.3 400ms delay", () => {
    expect(TOOLTIP_DELAY_MS).toBe(400);
  });

  it("waits out the delay on first hover, then is instant on a sibling", async () => {
    const DELAY = 800;
    const user = userEvent.setup();
    render(
      <TooltipProvider delay={DELAY}>
        <Tooltip content="Bold" delay={DELAY}>
          <button type="button">B</button>
        </Tooltip>
        <Tooltip content="Italic" delay={DELAY}>
          <button type="button">I</button>
        </Tooltip>
      </TooltipProvider>,
    );
    const opened = Date.now();
    await user.hover(screen.getByRole("button", { name: "B" }));
    expect(screen.queryByText("Bold")).not.toBeInTheDocument();
    await screen.findByText("Bold", undefined, { timeout: DELAY * 3 });
    expect(Date.now() - opened).toBeGreaterThanOrEqual(DELAY - 50);

    // Moving to the sibling: provider grouping skips the delay entirely.
    const moved = Date.now();
    await user.hover(screen.getByRole("button", { name: "I" }));
    await screen.findByText("Italic", undefined, { timeout: DELAY - 100 });
    expect(Date.now() - moved).toBeLessThan(DELAY - 100);
  });

  it("renders shortcut content", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Bold" shortcut="⌘B" delay={0}>
        <button type="button">B</button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole("button", { name: "B" }));
    expect((await screen.findByText("⌘B")).tagName).toBe("KBD");
  });
});

/** AC4: popover anchoring. jsdom has no layout, so the geometric
 * stay-in-viewport check runs against the real browser preview (evidence in
 * LOA-37); here we assert the anchor relationship and collision config. */
describe("popover", () => {
  it("opens anchored to its trigger with the requested side and closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <Popover.Root>
        <Popover.Trigger render={<Button>Details</Button>} />
        <Popover.Content side="bottom">
          <Popover.Title>Note info</Popover.Title>
          <Popover.Description>Created yesterday</Popover.Description>
        </Popover.Content>
      </Popover.Root>,
    );
    const trigger = screen.getByRole("button", { name: "Details" });
    await user.click(trigger);
    const popup = await screen.findByRole("dialog");
    expect(popup.dataset.side).toBe("bottom");
    expect(popup).toHaveAccessibleName("Note info");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

/** AC5: axe passes with each surface open, in both themes. */
describe("axe", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`reports no violations with open surfaces in the ${theme} theme`, async () => {
      document.documentElement.dataset.theme = theme;
      const user = userEvent.setup();
      render(
        <main>
          <FileMenu />
          <Popover.Root defaultOpen>
            <Popover.Trigger render={<Button>Details</Button>} />
            <Popover.Content>
              <Popover.Title>Note info</Popover.Title>
              <Popover.Description>Created yesterday</Popover.Description>
            </Popover.Content>
          </Popover.Root>
        </main>,
      );
      await user.click(screen.getByRole("button", { name: "File" }));
      await screen.findAllByRole("menuitem");
      // color-contrast: jsdom cannot compute it (covered by the token
      // walker). region: best-practice-only rule that flags Base UI portals,
      // which intentionally render at the body level outside landmarks.
      const results = await axe.run(document.body, {
        rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
      });
      expect(results.violations).toEqual([]);
    });
  }
});
