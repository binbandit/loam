/** LOA-33: button, input, and form-control primitives. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "./button";
import { Checkbox, Radio, RadioGroup, Switch } from "./choice";
import { Input, SearchField, Textarea } from "./input";

const css = readFileSync(join(__dirname, "controls.css"), "utf8").replace(/\r\n/g, "\n");

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

/** AC1: every control is keyboard reachable and operable. */
describe("keyboard operability", () => {
  it("buttons activate with Enter and Space", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Rename</Button>);
    await user.tab();
    expect(screen.getByRole("button", { name: "Rename" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("checkbox and switch toggle with Space", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Checkbox>Show hidden files</Checkbox>
        <Switch>Spell check</Switch>
      </>,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Show hidden files" });
    const toggle = screen.getByRole("switch", { name: "Spell check" });
    await user.tab();
    expect(checkbox).toHaveFocus();
    await user.keyboard(" ");
    expect(checkbox).toBeChecked();
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard(" ");
    expect(toggle).toBeChecked();
  });

  it("radio group moves selection with arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <RadioGroup defaultValue="dark" aria-label="Theme">
        <Radio value="dark">Dark</Radio>
        <Radio value="light">Light</Radio>
      </RadioGroup>,
    );
    await user.tab();
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
  });

  it("text inputs are focusable in order", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Input aria-label="Title" />
        <Textarea aria-label="Body" />
        <SearchField aria-label="Search" />
      </>,
    );
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Body" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveFocus();
    await user.keyboard("graph view");
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("graph view");
  });

  it("clicking a wrapping label toggles the control", async () => {
    const user = userEvent.setup();
    render(<Checkbox>Readable line length</Checkbox>);
    await user.click(screen.getByText("Readable line length"));
    expect(screen.getByRole("checkbox")).toBeChecked();
  });
});

/** AC2: icon-only buttons must carry an accessible name. */
describe("icon button labelling", () => {
  it("throws a development error without a label", () => {
    const silenced = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        // @ts-expect-error — the missing label is the point of the test.
        <IconButton>
          <svg aria-hidden="true" />
        </IconButton>,
      ),
    ).toThrow(/accessible name/);
    silenced.mockRestore();
  });

  it("exposes the label as the accessible name", () => {
    render(
      <IconButton label="Copy link">
        <svg aria-hidden="true" />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });
});

/** AC3: focus styling is a 1.5 px accent ring, `:focus-visible` only. */
describe("focus ring", () => {
  it("uses a 1.5px accent outline under :focus-visible", () => {
    expect(css).toContain("outline: 1.5px solid var(--loam-accent)");
  });

  it("never styles bare :focus", () => {
    const bareFocus = css.match(/:focus(?!-visible|-within)\b/g) ?? [];
    expect(bareFocus).toHaveLength(0);
  });
});

/** AC4: hover and loading rules never move layout. */
describe("state geometry", () => {
  const LAYOUT_SAFE = new Set([
    "background",
    "background-color",
    "color",
    "border-color",
    "box-shadow",
    "outline",
    "outline-offset",
    "opacity",
    "translate",
  ]);

  function declarationsOf(selectorMarker: string): Array<[string, string]> {
    const found: Array<[string, string]> = [];
    for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = (match[1] as string).trim();
      if (!selector.includes(selectorMarker)) continue;
      for (const declaration of (match[2] as string).split(";")) {
        const colon = declaration.indexOf(":");
        if (colon < 0) continue;
        found.push([declaration.slice(0, colon).trim(), `${selector} → ${declaration.trim()}`]);
      }
    }
    return found;
  }

  it("hover rules only change paint properties", () => {
    const hover = declarationsOf(":hover");
    expect(hover.length).toBeGreaterThan(0);
    for (const [property, context] of hover) {
      expect(LAYOUT_SAFE.has(property), context).toBe(true);
    }
  });

  it("loading overlays the spinner and keeps content in flow", () => {
    for (const [property, context] of declarationsOf("[data-loading]")) {
      expect(LAYOUT_SAFE.has(property), context).toBe(true);
    }
    render(<Button loading>Rename 143 links</Button>);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    // The label stays in the flow (opacity-hidden), so width cannot change.
    expect(screen.getByText("Rename 143 links")).toBeInTheDocument();
  });

  it("shortcut hints render inline on buttons and search fields", () => {
    render(
      <>
        <Button shortcut="⌘⏎">Open</Button>
        <SearchField aria-label="Search" shortcut="⌘K" />
      </>,
    );
    expect(screen.getByText("⌘⏎").tagName).toBe("KBD");
    expect(screen.getByText("⌘K").tagName).toBe("KBD");
  });

  it("invalid state is exposed via aria-invalid", () => {
    render(
      <>
        <Input aria-label="Title" invalid />
        <Textarea aria-label="Body" invalid />
      </>,
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: "Body" })).toHaveAttribute("aria-invalid", "true");
  });
});

/** AC5: axe passes on the full control set in both themes. Contrast is
 * excluded here (jsdom cannot compute it) — the token walker in
 * tokens.test.ts asserts every documented pair instead. */
describe("axe", () => {
  function Fixture() {
    return (
      <main>
        <Button variant="primary">New note</Button>
        <Button variant="danger" loading>
          Delete
        </Button>
        <IconButton label="Copy link">
          <svg aria-hidden="true" />
        </IconButton>
        <Input aria-label="Note title" />
        <Textarea aria-label="Description" invalid />
        <SearchField aria-label="Search notes" shortcut="⌘K" />
        <Checkbox defaultChecked>Show hidden files</Checkbox>
        <Switch>Spell check</Switch>
        <RadioGroup defaultValue="dark" aria-label="Theme">
          <Radio value="dark">Dark</Radio>
          <Radio value="light">Light</Radio>
        </RadioGroup>
      </main>
    );
  }

  for (const theme of ["dark", "light"] as const) {
    it(`reports no violations in the ${theme} theme`, async () => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(<Fixture />);
      const results = await axe.run(container, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(results.violations).toEqual([]);
    });
  }
});
