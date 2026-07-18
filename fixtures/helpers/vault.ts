import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * An isolated on-disk vault for tests. Always rooted in the OS temp
 * directory — never inside the repository — and disposable.
 */
export interface TempVault {
  root: string;
  /** Write a file inside the vault; nested folders are created. Returns the absolute path. */
  write(relativePath: string, content: string): string;
  /** Remove the vault and everything in it. Safe to call twice. */
  dispose(): void;
}

export function createTempVault(prefix = "loam-test-vault-"): TempVault {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    write(relativePath, content) {
      const absolute = resolve(root, relativePath);
      if (absolute !== root && !absolute.startsWith(root + sep)) {
        throw new Error(`Refusing to write outside the vault: ${relativePath}`);
      }
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
      return absolute;
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
