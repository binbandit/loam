import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures = [];

// D12: app + core are AGPL-3.0-only; plugin-sdk and fixtures are MIT.
const expectedManifests = {
  "package.json": "AGPL-3.0-only",
  "apps/desktop/package.json": "AGPL-3.0-only",
  "packages/ui/package.json": "AGPL-3.0-only",
  "packages/ipc-client/package.json": "AGPL-3.0-only",
  "packages/markdown-wasm/package.json": "AGPL-3.0-only",
  "docs/package.json": "AGPL-3.0-only",
  "packages/plugin-sdk/package.json": "MIT",
};

for (const [path, expected] of Object.entries(expectedManifests)) {
  const manifest = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  if (manifest.license !== expected) {
    failures.push(`${path}: license is "${manifest.license}", expected "${expected}"`);
  }
}

const cargo = readFileSync(resolve(root, "Cargo.toml"), "utf8");
if (!/license = "AGPL-3.0-only"/.test(cargo)) {
  failures.push('Cargo.toml: workspace.package.license must be "AGPL-3.0-only"');
}

const expectedLicenseFiles = {
  LICENSE: "GNU AFFERO GENERAL PUBLIC LICENSE",
  "packages/plugin-sdk/LICENSE": "MIT License",
  "fixtures/LICENSE": "MIT License",
};

for (const [path, marker] of Object.entries(expectedLicenseFiles)) {
  let text;
  try {
    text = readFileSync(resolve(root, path), "utf8");
  } catch {
    failures.push(`${path}: missing license file`);
    continue;
  }
  if (!text.includes(marker)) {
    failures.push(`${path}: does not look like the expected license (missing "${marker}")`);
  }
}

if (failures.length > 0) {
  throw new Error(`License audit failed:\n${failures.join("\n")}`);
}

console.log(
  `License check passed (${Object.keys(expectedManifests).length} manifests, Cargo workspace, ${Object.keys(expectedLicenseFiles).length} license files)`,
);
