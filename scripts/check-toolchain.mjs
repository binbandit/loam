import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const pinned = {
  node: readFileSync(resolve(root, ".node-version"), "utf8").trim(),
  pnpm: manifest.packageManager.split("@").at(-1),
  rust: readFileSync(resolve(root, "rust-toolchain.toml"), "utf8").match(
    /channel = "([^"]+)"/,
  )?.[1],
};
const installed = {
  node: process.versions.node,
  pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
  rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).split(" ")[1],
};

const mismatches = Object.keys(pinned).filter((tool) => pinned[tool] !== installed[tool]);
if (mismatches.length > 0) {
  const details = mismatches.map(
    (tool) => `${tool}: expected ${pinned[tool]}, found ${installed[tool]}`,
  );
  throw new Error(`Toolchain mismatch:\n${details.join("\n")}`);
}

console.log(
  `Toolchain check passed (Node ${installed.node}, pnpm ${installed.pnpm}, Rust ${installed.rust})`,
);
