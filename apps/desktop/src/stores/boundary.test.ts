/** LOA-66 AC3: domain stores never import Tauri APIs — only ipc-client. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("import boundary", () => {
  it("stores import nothing Tauri-shaped", () => {
    const dir = __dirname;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const source = readFileSync(join(dir, entry), "utf8");
      expect(source, entry).not.toMatch(/@tauri-apps|__TAURI/);
    }
  });

  it("the whole frontend only reaches the filesystem through ipc-client", () => {
    const srcDir = join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (
          /\.(ts|tsx)$/.test(entry.name) &&
          !entry.name.endsWith(".d.ts") &&
          !entry.name.includes(".test.")
        ) {
          const source = readFileSync(path, "utf8");
          if (/from "@tauri-apps/.test(source)) offenders.push(entry.name);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
