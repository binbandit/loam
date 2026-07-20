/** LOA-50: virtualized list, rows, and tree. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ListRow, ResultRow } from "./rows";
import { flattenTree, Tree, type TreeNode } from "./tree";
import { VirtualList } from "./virtual-list";

const css = readFileSync(join(__dirname, "list.css"), "utf8").replace(/\r\n/g, "\n");

/* jsdom has no layout: give the virtualizer a real-looking scroll element.
 * TanStack Virtual reads getBoundingClientRect + ResizeObserver. */
const VIEWPORT_HEIGHT = 300;
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  const heightOf = (el: Element): number =>
    el.classList.contains("loam-virtual") ? VIEWPORT_HEIGHT : 0;
  Element.prototype.getBoundingClientRect = function rect(): DOMRect {
    const height = heightOf(this);
    return {
      width: 240,
      height,
      top: 0,
      left: 0,
      bottom: height,
      right: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(): number {
      return heightOf(this as Element);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(): number {
      return 240;
    },
  });
});

afterEach(() => {
  cleanup();
});

/** AC1: 100k rows mount only the window plus overscan. */
describe("virtual list", () => {
  it("renders only the visible window of a 100k fixture", () => {
    const COUNT = 100_000;
    render(
      <VirtualList
        count={COUNT}
        rowHeight={28}
        label="All notes"
        role="listbox"
        activeIndex={0}
        renderRow={({ index, domId }) => (
          <div id={domId} role="option" tabIndex={-1} aria-selected={false}>
            Note {index}
          </div>
        )}
        style={{ height: VIEWPORT_HEIGHT }}
      />,
    );
    const rendered = document.querySelectorAll(".loam-virtual__row").length;
    // ceil(300 / 28) = 11 visible + 8 overscan (+ edge row).
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(40);
    expect(screen.getByRole("listbox", { name: "All notes" })).toBeInTheDocument();
  });

  /** AC2: focus stays on the container across scroll and remeasurement. */
  it("keeps keyboard focus and active row across scrolling", async () => {
    const user = userEvent.setup();
    function ListHarness() {
      const [active, setActive] = useState(0);
      return (
        <VirtualList
          count={100_000}
          rowHeight={28}
          label="All notes"
          role="listbox"
          activeIndex={active}
          onActiveIndexChange={setActive}
          renderRow={({ index, domId, active: isActive }) => (
            <div id={domId} role="option" tabIndex={-1} aria-selected={isActive}>
              Note {index}
            </div>
          )}
          style={{ height: VIEWPORT_HEIGHT }}
        />
      );
    }
    render(<ListHarness />);
    const list = screen.getByRole("listbox", { name: "All notes" });
    await user.click(list);
    list.focus();
    expect(list).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(list.getAttribute("aria-activedescendant")).toMatch(/-row-3$/);
    // Scroll far away — the focused container must survive rows unmounting.
    fireEvent.scroll(list, { target: { scrollTop: 50_000 * 28 } });
    expect(list).toHaveFocus();
    expect(list.getAttribute("aria-activedescendant")).toMatch(/-row-3$/);
    // End jumps to the last row and remounts it.
    await user.keyboard("{End}");
    expect(list.getAttribute("aria-activedescendant")).toMatch(/-row-99999$/);
    expect(list).toHaveFocus();
  });
});

const TREE: TreeNode[] = [
  {
    id: "projects",
    label: "Projects",
    children: [
      { id: "loam", label: "Loam.md" },
      { id: "garden", label: "Garden.md" },
      { id: "reading", label: "Reading list.md" },
    ],
  },
  { id: "daily", label: "Daily note.md" },
  { id: "ideas", label: "Ideas.md" },
];

/** AC3: level / expanded / selected / multiselect semantics. */
describe("tree semantics", () => {
  it("flattens only expanded branches", () => {
    expect(flattenTree(TREE, new Set()).map((entry) => entry.node.id)).toEqual([
      "projects",
      "daily",
      "ideas",
    ]);
    expect(flattenTree(TREE, new Set(["projects"])).length).toBe(6);
  });

  it("exposes tree, level, expanded, and multiselectable semantics", async () => {
    const user = userEvent.setup();
    render(<Tree nodes={TREE} label="Files" height={VIEWPORT_HEIGHT} />);
    const tree = screen.getByRole("tree", { name: "Files" });
    expect(tree).toHaveAttribute("aria-multiselectable", "true");
    const folder = screen.getByRole("treeitem", { name: "Projects" });
    expect(folder).toHaveAttribute("aria-level", "1");
    expect(folder).toHaveAttribute("aria-expanded", "false");
    // Expand from the keyboard.
    tree.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(screen.getByRole("treeitem", { name: "Projects" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    expect(screen.getByRole("treeitem", { name: "Loam.md" })).toHaveAttribute("aria-level", "2");
    // Collapse back.
    await user.keyboard("{ArrowLeft}");
    await waitFor(() =>
      expect(screen.queryByRole("treeitem", { name: "Loam.md" })).not.toBeInTheDocument(),
    );
  });
});

/** AC4: §4.4 selection model — ⌘-click toggles, ⇧-click ranges. */
describe("tree selection", () => {
  it("supports click, meta-toggle, and shift-range selection", async () => {
    const user = userEvent.setup();
    const onSelectedChange = vi.fn();
    render(
      <Tree
        nodes={TREE}
        label="Files"
        height={VIEWPORT_HEIGHT}
        expanded={new Set(["projects"])}
        onSelectedChange={onSelectedChange}
      />,
    );
    await user.click(screen.getByText("Loam.md"));
    expect([...(onSelectedChange.mock.lastCall?.[0] ?? [])]).toEqual(["loam"]);
    // ⇧-click selects the contiguous range from the anchor (Loam.md).
    await user.keyboard("{Shift>}");
    await user.click(screen.getByText("Reading list.md"));
    await user.keyboard("{/Shift}");
    expect(new Set(onSelectedChange.mock.lastCall?.[0])).toEqual(
      new Set(["loam", "garden", "reading"]),
    );
    // ⌘-click adds a non-adjacent row (and moves the anchor).
    await user.keyboard("{Meta>}");
    await user.click(screen.getByText("Ideas.md"));
    await user.keyboard("{/Meta}");
    expect(new Set(onSelectedChange.mock.lastCall?.[0])).toEqual(
      new Set(["loam", "garden", "reading", "ideas"]),
    );
    // ⌘-click again removes it.
    await user.keyboard("{Meta>}");
    await user.click(screen.getByText("Ideas.md"));
    await user.keyboard("{/Meta}");
    expect(new Set(onSelectedChange.mock.lastCall?.[0])).toEqual(
      new Set(["loam", "garden", "reading"]),
    );
  });
});

/** AC5: rename and drop indicators never move row geometry. */
describe("rename and drop", () => {
  it("inline rename renders an input inside the fixed-height row and commits on Enter", async () => {
    const user = userEvent.setup();
    const onRenameCommit = vi.fn();
    render(
      <Tree
        nodes={TREE}
        label="Files"
        height={VIEWPORT_HEIGHT}
        renamingId="ideas"
        onRenameCommit={onRenameCommit}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Rename Ideas.md" });
    expect(input).toHaveValue("Ideas.md");
    await user.clear(input);
    await user.type(input, "Sparks.md{Enter}");
    expect(onRenameCommit).toHaveBeenCalledWith("ideas", "Sparks.md");
  });

  it("drop indicator overlays absolutely and row heights are fixed", () => {
    render(
      <Tree
        nodes={TREE}
        label="Files"
        height={VIEWPORT_HEIGHT}
        dropIndicator={{ id: "daily", position: "below" }}
      />,
    );
    const row = screen.getByText("Daily note.md").closest(".loam-list-row") as HTMLElement;
    expect(row.dataset.drop).toBe("below");
    expect(row.querySelector(".loam-drop-indicator")).not.toBeNull();
    // Geometry is protected by the stylesheet: the indicator is absolute
    // and rows have a fixed height.
    expect(css).toMatch(/\.loam-drop-indicator\s*\{[^}]*position: absolute/);
    expect(css).toMatch(/\.loam-list-row\s*\{[^}]*height: var\(--loam-row-sidebar\)/);
    expect(css).toMatch(/\.loam-result-row\s*\{[^}]*height: var\(--loam-row-omnibar\)/);
  });
});

describe("rows", () => {
  it("ListRow renders icon, detail, and shortcut slots", () => {
    render(
      <ListRow icon={<svg data-testid="icon" />} detail={12} shortcut="⌘1" selected>
        Backlinks
      </ListRow>,
    );
    expect(screen.getByText("Backlinks")).toBeInTheDocument();
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByText("12")).toHaveClass("loam-list-row__detail");
    expect(screen.getByText("⌘1")).toHaveClass("loam-list-row__shortcut");
  });

  it("ResultRow renders title, detail, and meta columns at 40px", () => {
    render(<ResultRow title="Ideas.md" detail="Projects / Notes" meta="⌘⏎" active />);
    expect(screen.getByText("Ideas.md")).toHaveClass("loam-result-row__title");
    expect(screen.getByText("Projects / Notes")).toHaveClass("loam-result-row__detail");
    expect(screen.getByText("⌘⏎")).toHaveClass("loam-result-row__meta");
  });
});

/** §4.6: axe passes over the virtualized tree in both themes. */
describe("axe", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`reports no violations (${theme})`, async () => {
      document.documentElement.dataset.theme = theme;
      render(
        <main>
          <Tree
            nodes={TREE}
            label="Files"
            height={VIEWPORT_HEIGHT}
            expanded={new Set(["projects"])}
          />
        </main>,
      );
      const axe = (await import("axe-core")).default;
      const results = await axe.run(document.body, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(results.violations).toEqual([]);
      delete document.documentElement.dataset.theme;
    });
  }
});
