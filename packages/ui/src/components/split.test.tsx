/** LOA-52: split-pane resizer. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPLIT_KEYBOARD_STEP, SplitPane } from "./split";

const css = readFileSync(join(__dirname, "split.css"), "utf8").replace(/\r\n/g, "\n");

afterEach(cleanup);

function renderSplit(overrides: Partial<Parameters<typeof SplitPane>[0]> = {}) {
  const onSizeChange = vi.fn();
  const onCollapse = vi.fn();
  render(
    <SplitPane
      label="Resize sidebar"
      defaultSize={240}
      minSize={120}
      maxSize={480}
      onSizeChange={onSizeChange}
      onCollapse={onCollapse}
      {...overrides}
    >
      <div>sidebar</div>
      <div>editor</div>
    </SplitPane>,
  );
  return { separator: screen.getByRole("separator"), onSizeChange, onCollapse };
}

/** AC1: pointer drags report clamped sizes. */
describe("pointer resizing", () => {
  it("drags resize the first pane and clamp to [min, max]", () => {
    const { separator, onSizeChange } = renderSplit();
    fireEvent.pointerDown(separator, { clientX: 240, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 300, pointerId: 1 });
    expect(onSizeChange).toHaveBeenLastCalledWith(300);
    // Far beyond max clamps to 480.
    fireEvent.pointerMove(separator, { clientX: 1000, pointerId: 1 });
    expect(onSizeChange).toHaveBeenLastCalledWith(480);
    // Slightly below min clamps to 120 (no collapse yet).
    fireEvent.pointerMove(separator, { clientX: 100, pointerId: 1 });
    expect(onSizeChange).toHaveBeenLastCalledWith(120);
    fireEvent.pointerUp(separator, { pointerId: 1 });
    expect(separator).toHaveAttribute("aria-valuenow", "120");
  });

  it("dragging well below the minimum collapses", () => {
    const { separator, onCollapse } = renderSplit();
    fireEvent.pointerDown(separator, { clientX: 240, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 30, pointerId: 1 });
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("column direction resizes along the y axis", () => {
    const { separator, onSizeChange } = renderSplit({ direction: "column" });
    fireEvent.pointerDown(separator, { clientY: 240, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientY: 280, pointerId: 1 });
    expect(onSizeChange).toHaveBeenLastCalledWith(280);
  });
});

/** AC2: arrow keys resize by the documented 16 px increment. */
describe("keyboard resizing", () => {
  it("arrows step by the documented increment; Home/End hit the bounds", async () => {
    const user = userEvent.setup();
    const { separator, onSizeChange } = renderSplit();
    expect(SPLIT_KEYBOARD_STEP).toBe(16);
    separator.focus();
    await user.keyboard("{ArrowRight}");
    expect(onSizeChange).toHaveBeenLastCalledWith(240 + 16);
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(onSizeChange).toHaveBeenLastCalledWith(240 - 16);
    await user.keyboard("{Home}");
    expect(onSizeChange).toHaveBeenLastCalledWith(120);
    await user.keyboard("{End}");
    expect(onSizeChange).toHaveBeenLastCalledWith(480);
  });

  it("Enter collapses when a collapse callback exists", async () => {
    const user = userEvent.setup();
    const { separator, onCollapse } = renderSplit();
    separator.focus();
    await user.keyboard("{Enter}");
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});

/** AC3: separator semantics. */
describe("separator semantics", () => {
  it("exposes orientation and value range", () => {
    const { separator } = renderSplit();
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("aria-valuenow", "240");
    expect(separator).toHaveAttribute("aria-valuemin", "120");
    expect(separator).toHaveAttribute("aria-valuemax", "480");
    expect(separator).toHaveAccessibleName("Resize sidebar");
  });

  it("column direction flips the reported orientation", () => {
    const { separator } = renderSplit({ direction: "column" });
    expect(separator).toHaveAttribute("aria-orientation", "horizontal");
  });
});

/** AC4: hover/drag/focus visuals never move layout. */
describe("state geometry", () => {
  it("interaction states only change paint properties", () => {
    const PAINT_ONLY = new Set([
      "background",
      "background-color",
      "color",
      "opacity",
      "box-shadow",
    ]);
    for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = (match[1] as string).trim();
      if (!/:hover|\[data-dragging\]|:focus-visible/.test(selector)) continue;
      for (const declaration of (match[2] as string).split(";")) {
        const colon = declaration.indexOf(":");
        if (colon < 0) continue;
        const property = declaration.slice(0, colon).trim();
        expect(PAINT_ONLY.has(property), `${selector} → ${property}`).toBe(true);
      }
    }
    // The hit area is exactly 4px in both directions.
    expect(css).toMatch(/data-direction="row"[^{]*\{\s*width: 4px/);
    expect(css).toMatch(/data-direction="column"[^{]*\{\s*height: 4px/);
  });
});
