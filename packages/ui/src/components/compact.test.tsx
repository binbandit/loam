/** LOA-45: tabs, breadcrumb, badge/chip, segmented control, slider, kbd. */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Badge, Chip } from "./badge";
import { Breadcrumb, BreadcrumbItem } from "./breadcrumb";
import { Kbd, keyLabel } from "./kbd";
import { Segment, SegmentedControl } from "./segmented";
import { Slider } from "./slider";
import { Tabs } from "./tabs";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("dir");
});

function PanelTabs({ activateOnFocus = true }: { activateOnFocus?: boolean }) {
  return (
    <Tabs.Root defaultValue="backlinks">
      <Tabs.List variant="panel" activateOnFocus={activateOnFocus} aria-label="Note panels">
        <Tabs.Tab value="backlinks">Backlinks</Tabs.Tab>
        <Tabs.Tab value="outline">Outline</Tabs.Tab>
        <Tabs.Tab value="tags">Tags</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="backlinks">No linked mentions yet.</Tabs.Panel>
      <Tabs.Panel value="outline">Outline panel</Tabs.Panel>
      <Tabs.Panel value="tags">Tags panel</Tabs.Panel>
    </Tabs.Root>
  );
}

/** AC1: arrow-key focus movement and the activation policy. */
describe("tabs", () => {
  it("exposes tab semantics and activates with arrows when activateOnFocus", async () => {
    const user = userEvent.setup();
    render(<PanelTabs />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    await user.tab();
    expect(tabs[0]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(tabs[1]).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByText("Outline panel")).toBeInTheDocument();
  });

  it("moves focus without activating when activateOnFocus is false", async () => {
    const user = userEvent.setup();
    render(<PanelTabs activateOnFocus={false} />);
    const tabs = screen.getAllByRole("tab");
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(tabs[1]).toHaveFocus();
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(tabs[1]).toHaveAttribute("aria-selected", "true"));
  });

  it("panel is reachable and labelled by its tab", async () => {
    render(<PanelTabs />);
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAccessibleName("Backlinks");
  });
});

/** AC2: truncation is CSS-only — accessible names stay complete. */
describe("breadcrumb", () => {
  it("keeps the full accessible name on truncated segments", () => {
    const longName = "A very long folder name that will certainly truncate visually";
    render(
      <Breadcrumb>
        <BreadcrumbItem href="#vault">Vault</BreadcrumbItem>
        <BreadcrumbItem href="#projects">{longName}</BreadcrumbItem>
        <BreadcrumbItem current>Ideas.md</BreadcrumbItem>
      </Breadcrumb>,
    );
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: longName })).toBeInTheDocument();
    expect(screen.getByText("Ideas.md")).toHaveAttribute("aria-current", "page");
    // The truncation class is applied (visual ellipsis only).
    expect(screen.getByRole("link", { name: longName })).toHaveClass("loam-breadcrumb__link");
  });
});

describe("badge and chip", () => {
  it("renders count badges with variants", () => {
    render(<Badge variant="accent">12</Badge>);
    expect(screen.getByText("12")).toHaveAttribute("data-variant", "accent");
  });

  it("chip remove button is labelled after the tag", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<Chip onRemove={onRemove}>reading</Chip>);
    await user.click(screen.getByRole("button", { name: "Remove reading" }));
    expect(onRemove).toHaveBeenCalled();
  });

  it("chip with onRemove and no derivable label throws in development", () => {
    const silenced = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <Chip onRemove={() => {}}>
          <em>styled</em>
        </Chip>,
      ),
    ).toThrow(/label/);
    silenced.mockRestore();
  });
});

describe("segmented control", () => {
  it("toggles selection between segments", async () => {
    const user = userEvent.setup();
    render(
      <SegmentedControl defaultValue={["edit"]} aria-label="Editor mode">
        <Segment value="edit">Edit</Segment>
        <Segment value="read">Read</Segment>
      </SegmentedControl>,
    );
    const read = screen.getByRole("button", { name: "Read" });
    await user.click(read);
    expect(read).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute("aria-pressed", "false");
  });
});

/** AC3: value text and keyboard increments. */
describe("slider", () => {
  it("exposes value text and increments with arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <Slider label="Editor font size" defaultValue={16} min={12} max={24} step={1} showValue />,
    );
    const slider = screen.getByRole("slider", { name: "Editor font size" });
    expect(slider).toHaveAttribute("aria-valuenow", "16");
    // The visible value text readout mirrors the thumb value.
    expect(screen.getByText("16")).toHaveClass("loam-slider__value");
    await user.click(slider);
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(slider).toHaveAttribute("aria-valuenow", "17"));
    expect(screen.getByText("17")).toHaveClass("loam-slider__value");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    await waitFor(() => expect(slider).toHaveAttribute("aria-valuenow", "15"));
  });
});

/** AC4: platform modifier mapping. */
describe("kbd", () => {
  it("maps Mod/Alt/Shift to mac glyphs", () => {
    render(<Kbd keys="Mod+Shift+K" platform="mac" />);
    const kbd = screen.getByText("⌘⇧K");
    expect(kbd.tagName).toBe("KBD");
    expect(kbd).toHaveAttribute("aria-label", "Command Shift K");
  });

  it("maps Mod/Alt/Shift to labels elsewhere", () => {
    render(<Kbd keys="Mod+Alt+P" platform="other" />);
    const kbd = screen.getByText("Ctrl+Alt+P");
    expect(kbd).toHaveAttribute("aria-label", "Control Alt P");
  });

  it("maps special keys on both platforms", () => {
    expect(keyLabel("Enter", "mac")).toBe("⏎");
    expect(keyLabel("Backspace", "other")).toBe("⌫");
    expect(keyLabel("Escape", "mac")).toBe("Esc");
    expect(keyLabel("ArrowUp", "other")).toBe("↑");
    expect(keyLabel("k", "mac")).toBe("K");
  });
});

/** AC5 (jsdom half): axe passes in both themes and under RTL; visual
 * dark/light/RTL snapshots are captured in the browser (issue evidence). */
describe("axe", () => {
  function Fixture() {
    return (
      <main>
        <PanelTabs />
        <Breadcrumb>
          <BreadcrumbItem href="#vault">Vault</BreadcrumbItem>
          <BreadcrumbItem current>Ideas.md</BreadcrumbItem>
        </Breadcrumb>
        <Badge>12</Badge>
        <Chip onRemove={() => {}}>reading</Chip>
        <SegmentedControl defaultValue={["edit"]} aria-label="Editor mode">
          <Segment value="edit">Edit</Segment>
          <Segment value="read">Read</Segment>
        </SegmentedControl>
        <Slider label="Editor font size" defaultValue={16} min={12} max={24} showValue />
        <Kbd keys="Mod+K" platform="mac" />
      </main>
    );
  }

  for (const [theme, dir] of [
    ["dark", "ltr"],
    ["light", "ltr"],
    ["dark", "rtl"],
  ] as const) {
    it(`reports no violations (${theme}, ${dir})`, async () => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.setAttribute("dir", dir);
      const { container } = render(<Fixture />);
      const results = await axe.run(container, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(results.violations).toEqual([]);
    });
  }
});
