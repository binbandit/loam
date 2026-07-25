/** LOA-88: the >20 MB path — never read into memory, never written back. */

import type { NoteDoc } from "@loam-app/ipc-client";
import { createMockTransport, METADATA_ONLY_BYTES } from "@loam-app/ipc-client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LargeNoteNotice } from "./LargeNoteNotice";
import { NoteView } from "./NoteView";

const doc: NoteDoc = {
  path: "Huge.md",
  // §5.6: past 20 MB the reader returns metadata and a hash, never bytes.
  content: null,
  hash: "hash-huge",
  meta: {
    size: METADATA_ONLY_BYTES + 1,
    modifiedMs: null,
    readOnly: false,
    sizePolicy: "metadata-only",
    readMs: 1,
  },
};

const noteRead = vi.fn(async (_vaultId: string, _path: string) => ({
  status: "ok" as const,
  data: doc,
}));
vi.mock("../ipc", () => ({
  ipc: { getCommands: async () => ({ noteRead }) },
}));

const vault = {
  id: "v1",
  name: "Vault",
  readOnly: false,
  transientIdentity: false,
  counts: { notes: 1, folders: 0, attachments: 0 },
  indexStatus: "ready",
} as const;

beforeEach(() => {
  noteRead.mockClear();
});

describe("notes past the metadata-only line", () => {
  it("opens read-only and registers no save buffer (AC4)", async () => {
    const { createSavesStore } = await import("../stores/saves");
    const { createFindStore } = await import("../stores/find");
    const savesStore = createSavesStore(createMockTransport());
    const { container } = render(
      <NoteView
        vault={vault}
        path="Huge.md"
        savesStore={savesStore}
        findStore={createFindStore()}
      />,
    );
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
    // Nothing was registered, so an errant save can never truncate the file.
    expect(savesStore.getState().entries["Huge.md"]).toBeUndefined();
    expect(container.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false");
  });
});

describe("the notice", () => {
  const tab = {
    id: "tab-1",
    path: "Huge.md",
    title: "Huge",
    viewMode: "source",
    dirty: false,
    missing: false,
    sizePolicy: "source-only",
    noticeDismissed: false,
  } as const;

  it("explains the policy and can be dismissed (AC2)", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <LargeNoteNotice tab={tab} size={3 * 1024 * 1024} onDismiss={onDismiss} />,
    );
    const notice = screen.getByTestId("size-notice");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent("3.0 MB");
    expect(notice).toHaveTextContent("Source mode");
    await user.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(onDismiss).toHaveBeenCalledOnce();

    rerender(
      <LargeNoteNotice
        tab={{ ...tab, noticeDismissed: true }}
        size={3 * 1024 * 1024}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.queryByTestId("size-notice")).not.toBeInTheDocument();
  });

  it("says nothing for an ordinary note (AC1)", () => {
    render(
      <LargeNoteNotice tab={{ ...tab, sizePolicy: "normal" }} size={1024} onDismiss={vi.fn()} />,
    );
    expect(screen.queryByTestId("size-notice")).not.toBeInTheDocument();
  });
});
