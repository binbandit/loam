/** LOA-88: large-note editing policy (§3.2/§5.6). */

import { METADATA_ONLY_BYTES, SOURCE_ONLY_BYTES } from "@loam-app/ipc-client";
import { describe, expect, it } from "vitest";
import { createPanesStore } from "../stores/panes";
import { effectiveViewMode, formatSize, isEditable, isOversized, sizeNotice } from "./policy";

/** AC1: a note at or below 2 MB behaves exactly as before. */
describe("normal notes", () => {
  it("keeps the configured mode and stays editable", () => {
    expect(isOversized("normal")).toBe(false);
    expect(effectiveViewMode("reading", "normal")).toBe("reading");
    expect(effectiveViewMode("source", "normal")).toBe("source");
    expect(isEditable({ readOnly: false, sizePolicy: "normal" })).toBe(true);
    expect(sizeNotice({ size: SOURCE_ONLY_BYTES, sizePolicy: "normal" })).toBeNull();
  });
});

/** AC2/AC3: past the line, the mode is pinned and the notice explains why. */
describe("oversized notes", () => {
  it("pins any requested mode to Source", () => {
    expect(effectiveViewMode("reading", "source-only")).toBe("source");
    expect(effectiveViewMode("reading", "metadata-only")).toBe("source");
  });

  it("explains the policy with a human-readable size", () => {
    const notice = sizeNotice({ size: SOURCE_ONLY_BYTES + 1024, sizePolicy: "source-only" });
    expect(notice).toContain("2.0 MB");
    expect(notice).toContain("Source mode");
    expect(sizeNotice({ size: METADATA_ONLY_BYTES + 1, sizePolicy: "metadata-only" })).toContain(
      "too large to open",
    );
  });

  it("formats sizes in the units the thresholds use", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(SOURCE_ONLY_BYTES)).toBe("2.0 MB");
    expect(formatSize(METADATA_ONLY_BYTES)).toBe("20 MB");
  });
});

/** AC4: editable unless read-only — or never read into memory at all. */
describe("editability", () => {
  it("stays editable while oversized but readable", () => {
    expect(isEditable({ readOnly: false, sizePolicy: "source-only" })).toBe(true);
  });

  it("is read-only for read-only files and for unread bodies", () => {
    expect(isEditable({ readOnly: true, sizePolicy: "normal" })).toBe(false);
    expect(isEditable({ readOnly: false, sizePolicy: "metadata-only" })).toBe(false);
  });
});

/** AC3 at the store level: no toggle can leave Source while oversized. */
describe("tab mode clamping", () => {
  function storeWithNote(policy: Parameters<typeof isOversized>[0]) {
    const store = createPanesStore();
    store.getState().load("vault-1", new Set(["Big.md"]));
    store.getState().openPath("Big.md");
    store.getState().setSizePolicy("Big.md", policy);
    return store;
  }

  function tabOf(store: ReturnType<typeof createPanesStore>) {
    const root = store.getState().root;
    if (root.kind !== "pane") throw new Error("expected a single pane");
    return root.tabs[0];
  }

  it("a normal note follows the requested mode", () => {
    const store = storeWithNote("normal");
    store.getState().setViewMode("Big.md", "reading");
    expect(tabOf(store)?.viewMode).toBe("reading");
  });

  it("classifying an open note drops it back to Source", () => {
    const store = storeWithNote("normal");
    store.getState().setViewMode("Big.md", "reading");
    store.getState().setSizePolicy("Big.md", "source-only");
    expect(tabOf(store)?.viewMode).toBe("source");
  });

  it("requesting a rendered mode while oversized is refused", () => {
    const store = storeWithNote("source-only");
    store.getState().setViewMode("Big.md", "reading");
    expect(tabOf(store)?.viewMode).toBe("source");
    expect(tabOf(store)?.sizePolicy).toBe("source-only");
  });

  it("the notice is dismissible per tab", () => {
    const store = storeWithNote("source-only");
    expect(tabOf(store)?.noticeDismissed).toBe(false);
    store.getState().dismissSizeNotice("Big.md");
    expect(tabOf(store)?.noticeDismissed).toBe(true);
  });
});
