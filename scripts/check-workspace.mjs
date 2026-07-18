import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const requiredPaths = [
  "apps/desktop/src",
  "apps/desktop/src-tauri",
  "crates/loam-core",
  "crates/loam-bench",
  "packages/ui",
  "packages/plugin-sdk",
  "packages/markdown-wasm",
  "packages/ipc-client",
  "fixtures",
  "docs",
  ".github",
];

const missing = requiredPaths.filter((path) => !existsSync(resolve(root, path)));
if (missing.length > 0) {
  throw new Error(`Missing required workspace paths: ${missing.join(", ")}`);
}

const packagePaths = [
  "apps/desktop/package.json",
  "packages/ui/package.json",
  "packages/plugin-sdk/package.json",
  "packages/markdown-wasm/package.json",
  "packages/ipc-client/package.json",
  "docs/package.json",
];
const names = packagePaths.map((path) => {
  const manifest = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  if (!manifest.name || manifest.version !== "0.0.0") {
    throw new Error(`Invalid bootstrap package manifest: ${path}`);
  }
  return manifest.name;
});

if (new Set(names).size !== names.length) {
  throw new Error("Workspace package names must be unique");
}

const rootManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (rootManifest.packageManager !== "pnpm@11.13.1") {
  throw new Error("The pinned pnpm version does not match the bootstrap contract");
}

console.log(`Workspace check passed (${requiredPaths.length} paths, ${names.length} packages)`);
