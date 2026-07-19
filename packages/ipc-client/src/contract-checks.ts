/**
 * Compile-time contract checks (LOA-63 AC3): strict TypeScript must reject
 * stale call shapes against the generated client. Every `@ts-expect-error`
 * below FAILS the typecheck if the erroneous call ever becomes valid — i.e.
 * this file breaks loudly when the contract drifts in either direction.
 * Never imported at runtime.
 */

import { commands } from "./generated/bindings";

export async function contractChecks(): Promise<void> {
  // Correct shapes compile (positive control).
  await commands.noteRead("vault-id", "notes/x.md");
  await commands.noteWrite("vault-id", "notes/x.md", "content", null);

  // @ts-expect-error stale shape: note_read requires the vault id
  await commands.noteRead("notes/x.md");

  // @ts-expect-error stale shape: base hash argument is required (nullable, not omittable)
  await commands.noteWrite("vault-id", "notes/x.md", "content");

  // @ts-expect-error stale shape: numeric path was never valid
  await commands.noteRead("vault-id", 42);

  // @ts-expect-error stale command name: renamed/removed commands do not exist
  await commands.openVault("path");

  const result = await commands.vaultOpen("/tmp/vault");
  if (result.status === "ok") {
    // @ts-expect-error stale field: the contract VaultInfo has no `root`
    void result.data.root;
    void result.data.indexStatus;
  }
}
