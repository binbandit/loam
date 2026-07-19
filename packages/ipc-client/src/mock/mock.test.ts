/** LOA-64: the complete browser mock transport. */

import { describe, expect, it } from "vitest";
import { EVENT_FILE_CHANGED, EVENT_INDEX_PROGRESS } from "../events";
import type { EventEnvelope, VaultEvent } from "../generated/bindings";
import { createMockIpc } from "./index";

async function openFixture(
  mock = createMockIpc({
    vaults: {
      "/fixtures/demo": {
        name: "Demo",
        files: {
          "welcome.md": "# Welcome\n",
          "area/plan.md": "# Plan\n",
          "logo.png": "binary-ish",
        },
      },
    },
  }),
) {
  const opened = await mock.commands.vaultOpen("/fixtures/demo");
  if (opened.status !== "ok") {
    throw new Error("fixture vault opens");
  }
  return { mock, info: opened.data };
}

describe("mock transport", () => {
  /** AC1: open a fixture vault, read and write a note. */
  it("opens a fixture vault and reads/writes notes", async () => {
    const { mock, info } = await openFixture();
    expect(info.name).toBe("Demo");
    expect(info.counts).toEqual({ notes: 2, folders: 1, attachments: 1 });

    const read = await mock.commands.noteRead(info.id, "welcome.md");
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.data.content).toBe("# Welcome\n");

    const write = await mock.commands.noteWrite(
      info.id,
      "welcome.md",
      "# Welcome v2\n",
      read.data.hash,
    );
    expect(write.status).toBe("ok");

    const reread = await mock.commands.noteRead(info.id, "welcome.md");
    if (reread.status !== "ok") throw new Error("reread");
    expect(reread.data.content).toBe("# Welcome v2\n");
    if (write.status !== "ok") return;
    expect(reread.data.hash).toBe(write.data.hash);

    // Error paths carry the exact contract shapes.
    const missing = await mock.commands.noteRead(info.id, "nope.md");
    expect(missing).toEqual({
      status: "error",
      error: { error: "not-found", path: "nope.md" },
    });
    const unknown = await mock.commands.noteRead("bad-id", "welcome.md");
    expect(unknown).toEqual({
      status: "error",
      error: { error: "unknown-vault", id: "bad-id" },
    });
  });

  /** AC2: a stale base hash produces the native Conflict shape. */
  it("stale hashes produce the native conflict shape", async () => {
    const { mock, info } = await openFixture();
    const read = await mock.commands.noteRead(info.id, "welcome.md");
    if (read.status !== "ok") throw new Error("read");

    // External edit changes the disk content under the buffer.
    mock.emitExternalChange(info.id, "welcome.md", "# External\n");

    const conflict = await mock.commands.noteWrite(
      info.id,
      "welcome.md",
      "# Mine\n",
      read.data.hash,
    );
    expect(conflict.status).toBe("error");
    if (conflict.status !== "error") return;
    expect(conflict.error.error).toBe("conflict");
    if (conflict.error.error !== "conflict") return;
    expect(typeof conflict.error.diskHash).toBe("string");
    expect(conflict.error.path).toBe("welcome.md");

    // Same shape natively asserted in LOA-57:
    // {"error":"conflict","path":…,"diskHash":…}. Disk untouched:
    const disk = await mock.commands.noteRead(info.id, "welcome.md");
    if (disk.status !== "ok") throw new Error("disk read");
    expect(disk.data.content).toBe("# External\n");
  });

  /** AC3: events follow the native ordering contract. */
  it("events are enveloped, ordered, and origin-correct", async () => {
    const { mock, info } = await openFixture();
    const seen: Array<EventEnvelope<VaultEvent>> = [];
    mock.listen<VaultEvent>(EVENT_FILE_CHANGED, (envelope) => seen.push(envelope));

    const read = await mock.commands.noteRead(info.id, "welcome.md");
    if (read.status !== "ok") throw new Error("read");
    await mock.commands.noteWrite(info.id, "welcome.md", "# v2\n", read.data.hash);
    mock.emitExternalChange(info.id, "sync.md", "# Synced\n");
    mock.emitIndexProgress(info.id, { done: 1, total: 2 });
    await mock.commands.noteCreate(info.id, "", "Fresh");

    expect(seen.map((envelope) => envelope.payload.origin)).toEqual(["app", "external", "app"]);
    expect(seen[0]?.payload.type).toBe("modified");
    expect(seen[1]?.payload.type).toBe("created");
    expect(seen[2]?.payload.type).toBe("created");
    // Per-vault seq is monotonic ACROSS channels (index-progress consumed 3).
    const sequences = mock.emitted().map((entry) => entry.envelope.seq);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(mock.emitted().map((entry) => entry.channel)).toEqual([
      EVENT_FILE_CHANGED,
      EVENT_FILE_CHANGED,
      EVENT_INDEX_PROGRESS,
      EVENT_FILE_CHANGED,
    ]);
  });

  /** AC4: parallel mock instances share no state. */
  it("instances are fully isolated", async () => {
    const [first, second] = await Promise.all([openFixture(), openFixture()]);
    await first.mock.commands.noteWrite(first.info.id, "only-in-first.md", "# A\n", null);

    const missing = await second.mock.commands.noteRead(second.info.id, "only-in-first.md");
    expect(missing.status).toBe("error");
    expect(second.mock.emitted()).toHaveLength(0);
    expect(first.mock.emitted()).toHaveLength(1);
    // Even the vault ids are instance-local.
    const cross = await second.mock.commands.noteRead(first.info.id, "welcome.md");
    expect(cross.status).toBe("error");
  });

  /** Collision naming matches the native §3.8 policy exactly. */
  it("collision names follow the native policy", async () => {
    const { mock, info } = await openFixture();
    const first = await mock.commands.noteCreate(info.id, "", "welcome");
    if (first.status !== "ok") throw new Error("create");
    expect(first.data.path).toBe("welcome 1.md");
    const second = await mock.commands.noteDuplicate(info.id, "welcome.md");
    if (second.status !== "ok") throw new Error("duplicate");
    expect(second.data.path).toBe("welcome 2.md");
  });

  /** Controllable latency so the mock never masks latency tests. */
  it("supports controllable latency", async () => {
    const mock = createMockIpc({ latencyMs: 30 });
    const started = performance.now();
    await mock.commands.vaultOpen("/slow");
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  });

  /**
   * AC5 is compile-time: `MockCommands = typeof commands` — this test just
   * documents it. Removing a mock method or adding a Rust command fails
   * `pnpm typecheck` until the mock is updated.
   */
  it("implements the full generated command surface", async () => {
    const mock = createMockIpc();
    const generatedSurface = [
      "vaultOpen",
      "vaultPickAndOpen",
      "noteRead",
      "noteWrite",
      "noteCreate",
      "folderCreate",
      "noteRename",
      "noteDuplicate",
      "noteTrash",
    ].sort();
    expect(Object.keys(mock.commands).sort()).toEqual(generatedSurface);
    const picked = await mock.commands.vaultPickAndOpen();
    expect(picked).toEqual({ status: "ok", data: null });
  });
});
