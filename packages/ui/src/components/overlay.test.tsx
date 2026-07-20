/** LOA-39: modal, confirm dialog, toast, empty-state, and progress. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { ConfirmDialog, Modal } from "./dialog";
import { EmptyState, Progress } from "./feedback";
import { TOAST_LIMIT, TOAST_TIMEOUT_MS, Toasts, useToast } from "./toast";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

function InfoModal() {
  return (
    <Modal.Root>
      <Modal.Trigger render={<Button>Rename links</Button>} />
      <Modal.Content>
        <Modal.Title>Rename 143 links</Modal.Title>
        <Modal.Description>Links in 12 notes will be updated.</Modal.Description>
        <Modal.Footer>
          <Modal.Close render={<Button>Cancel</Button>} />
          <Modal.Close render={<Button variant="primary">Rename 143 links</Button>} />
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

/** AC1: focus is trapped inside the dialog and returns to the invoker. */
describe("modal focus lifecycle", () => {
  it("moves focus in, keeps tab cycles inside, and restores on close", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">before</button>
        <InfoModal />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Rename links" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    for (let i = 0; i < 4; i += 1) {
      await user.tab();
      // Base UI redirects focus-guard hits back into the trap asynchronously.
      await waitFor(() =>
        expect(dialog.contains(document.activeElement), `tab ${i + 1}`).toBe(true),
      );
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

/** AC2: Escape respects non-dismissible destructive states. */
describe("confirm dialog dismissal", () => {
  it("dismisses with Escape by default", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        trigger={<Button variant="danger">Delete note</Button>}
        title="Delete 'Ideas.md'?"
        description="The note moves to the system trash."
        confirmLabel="Delete note"
        danger
        onConfirm={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete note" }));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("ignores Escape when dismissible={false}; buttons still close", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        trigger={<Button variant="danger">Delete note</Button>}
        title="Delete 'Ideas.md'?"
        confirmLabel="Delete note"
        danger
        dismissible={false}
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete note" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete note", hidden: false }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });
});

function ToastHarness({ withAction = false }: { withAction?: boolean }) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        toast.add({
          title: "Couldn't sync",
          description: "The vault folder is offline.",
          actionProps: withAction ? { children: "Retry", onClick: () => {} } : undefined,
        })
      }
    >
      fire
    </button>
  );
}

/** AC3: stacking caps at three; hover pauses the timeout. */
describe("toasts", () => {
  it("defaults match §4.3 (5s, max 3)", () => {
    expect(TOAST_TIMEOUT_MS).toBe(5000);
    expect(TOAST_LIMIT).toBe(3);
  });

  it("caps visible toasts at three", async () => {
    const user = userEvent.setup();
    render(
      <Toasts>
        <ToastHarness />
      </Toasts>,
    );
    for (let i = 0; i < 4; i += 1) {
      await user.click(screen.getByRole("button", { name: "fire" }));
    }
    await waitFor(() => {
      const visible = document.querySelectorAll(".loam-toast:not([data-limited])");
      expect(visible.length).toBeLessThanOrEqual(3);
    });
    expect(document.querySelectorAll(".loam-toast").length).toBeGreaterThanOrEqual(4);
  });

  it("auto-dismisses after the timeout, but not while hovered", async () => {
    const user = userEvent.setup();
    render(
      <Toasts timeout={300}>
        <ToastHarness />
      </Toasts>,
    );
    await user.click(screen.getByRole("button", { name: "fire" }));
    const toast = await screen.findByText("Couldn't sync");
    await user.hover(toast);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.getByText("Couldn't sync")).toBeInTheDocument();
    await user.unhover(toast);
    await waitFor(() => expect(screen.queryByText("Couldn't sync")).not.toBeInTheDocument(), {
      timeout: 2000,
    });
  });

  /** AC4: announced politely without stealing focus. */
  it("announces via a polite live region and keeps focus where it was", async () => {
    const user = userEvent.setup();
    render(
      <Toasts>
        <ToastHarness withAction />
      </Toasts>,
    );
    const fire = screen.getByRole("button", { name: "fire" });
    await user.click(fire);
    await screen.findByText("Couldn't sync");
    expect(fire).toHaveFocus();
    const live = document.querySelector('[aria-live="polite"], [role="status"]');
    expect(live).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("empty state and progress", () => {
  it("renders one line and one action", () => {
    render(
      <EmptyState action={<Button variant="ghost">Link a note</Button>}>
        No linked mentions yet. Link to this note with [[Note name]].
      </EmptyState>,
    );
    expect(screen.getByText(/No linked mentions yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link a note" })).toBeInTheDocument();
  });

  it("exposes determinate progress and marks indeterminate", () => {
    const { rerender } = render(<Progress value={40} label="Indexing vault" />);
    const bar = screen.getByRole("progressbar", { name: "Indexing vault" });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(bar).not.toHaveAttribute("data-indeterminate");
    rerender(<Progress value={null} label="Indexing vault" />);
    expect(screen.getByRole("progressbar", { name: "Indexing vault" })).toHaveAttribute(
      "data-indeterminate",
    );
  });

  it("reduced-transparency scrim fallback is defined in the token sheet", () => {
    const tokens = readFileSync(join(__dirname, "../tokens/tokens.css"), "utf8");
    const media = tokens.slice(tokens.indexOf("@media (prefers-reduced-transparency: reduce)"));
    expect(media).toContain("--loam-scrim");
  });
});

/** AC5 (jsdom half): axe passes with modal + toast in both themes. Visual
 * theme snapshots are captured in the browser (evidence on the issue). */
describe("axe", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`reports no violations in the ${theme} theme`, async () => {
      document.documentElement.dataset.theme = theme;
      const user = userEvent.setup();
      render(
        <Toasts>
          <main>
            <ToastHarness />
            <InfoModal />
            <EmptyState action={<Button variant="ghost">Link a note</Button>}>
              No linked mentions yet.
            </EmptyState>
            <Progress value={40} label="Indexing vault" />
          </main>
        </Toasts>,
      );
      await user.click(screen.getByRole("button", { name: "fire" }));
      await user.click(screen.getByRole("button", { name: "Rename links" }));
      await screen.findByRole("dialog", { name: "Rename 143 links" });
      const results = await axe.run(document.body, {
        rules: {
          "color-contrast": { enabled: false },
          region: { enabled: false },
          "aria-hidden-focus": { enabled: false },
        },
      });
      expect(results.violations).toEqual([]);
    });
  }
});
