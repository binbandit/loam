import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempVault } from "../../../fixtures/helpers/vault";

describe("temp vault fixture helper", () => {
  it("creates vaults outside the repository and disposes them", () => {
    const vault = createTempVault();
    const repoRoot = resolve(import.meta.dirname, "../../..");
    expect(vault.root.startsWith(repoRoot)).toBe(false);
    expect(vault.root.startsWith(resolve(tmpdir()))).toBe(true);

    const note = vault.write("folder/Note.md", "# Hello\n");
    expect(readFileSync(note, "utf8")).toBe("# Hello\n");

    vault.dispose();
    expect(existsSync(vault.root)).toBe(false);
    vault.dispose(); // idempotent
  });

  it("refuses to write outside the vault root", () => {
    const vault = createTempVault();
    try {
      expect(() => vault.write("../escape.md", "nope")).toThrow(/outside the vault/);
    } finally {
      vault.dispose();
    }
  });
});
