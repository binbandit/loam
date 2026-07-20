/** LOA-80: right-panel framework — registration, generations, persistence. */

import { EmptyState } from "@loam-app/ui";
import { describe, expect, it } from "vitest";
import { backlinksView } from "../shell/RightPanel";
import { createPanelStore } from "./panel";

describe("panel store", () => {
  it("toggling never touches view state (AC1)", () => {
    const store = createPanelStore([backlinksView]);
    store.getState().setActiveNote("a.md");
    const generationBefore = store.getState().generation;
    store.getState().toggle();
    store.getState().toggle();
    expect(store.getState().activeViewId).toBe("backlinks");
    expect(store.getState().generation).toBe(generationBefore);
    expect(store.getState().activeNotePath).toBe("a.md");
  });

  it("changing the active note bumps the request generation (AC2)", () => {
    const store = createPanelStore([backlinksView]);
    const first = store.getState().setActiveNote("a.md");
    const second = store.getState().setActiveNote("b.md");
    expect(second).toBe(first + 1);
    // Same note again: no bump.
    expect(store.getState().setActiveNote("b.md")).toBe(second);
  });

  it("stale responses are identifiable and cannot win (AC3)", async () => {
    const store = createPanelStore([backlinksView]);
    const results: string[] = [];
    const request = async (path: string, delayMs: number): Promise<void> => {
      const generation = store.getState().setActiveNote(path);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      // The guard every data consumer uses before committing a response:
      if (store.getState().isCurrent(generation)) results.push(path);
    };
    // The slow reply for a.md lands AFTER b.md became active.
    const slow = request("a.md", 50);
    const fast = request("b.md", 5);
    await Promise.all([slow, fast]);
    expect(results).toEqual(["b.md"]);
  });

  it("width, collapse, and active tab restore per device (AC4)", () => {
    const secondView = {
      id: "outline",
      title: "Outline",
      render: () => <EmptyState>Outline lands in M2.</EmptyState>,
    };
    const store = createPanelStore([backlinksView, secondView]);
    store.getState().load("panel-vault");
    store.getState().setWidth(333);
    store.getState().toggle(); // collapsed -> false
    store.getState().setActiveView("outline");

    const fresh = createPanelStore([backlinksView, secondView]);
    fresh.getState().load("panel-vault");
    expect(fresh.getState().width).toBe(333);
    expect(fresh.getState().collapsed).toBe(false);
    expect(fresh.getState().activeViewId).toBe("outline");
  });

  it("registerView adds plugin-shaped views once", () => {
    const store = createPanelStore([backlinksView]);
    const view = {
      id: "tags",
      title: "Tags",
      render: () => <EmptyState>Tags land in M2.</EmptyState>,
    };
    store.getState().registerView(view);
    store.getState().registerView(view);
    expect(store.getState().views.map((candidate) => candidate.id)).toEqual(["backlinks", "tags"]);
    // Unknown view ids are rejected.
    store.getState().setActiveView("nope");
    expect(store.getState().activeViewId).toBe("backlinks");
  });
});
