import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// AGPL-3.0-distribution-compatible licenses acceptable in the app scope (§1.5).
const APP_ALLOW = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Zlib",
  "MPL-2.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Unlicense",
  "BlueOak-1.0.0",
  "Python-2.0",
  "Unicode-3.0",
  "AGPL-3.0-only",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
]);

// The MIT-scoped packages (plugin-sdk) must stay permissive-only so downstream
// plugin authors are unencumbered (D12) — no copyleft in their runtime deps.
const MIT_SCOPE_ALLOW = new Set(
  [...APP_ALLOW].filter((l) => !/^(AGPL|LGPL|GPL|MPL|CC-BY)/.test(l)),
);
const MIT_SCOPES = ["packages/plugin-sdk"];

/** SPDX-lite evaluation: OR = any side allowed, AND = both. */
export function licenseAllowed(expression, allowSet) {
  if (!expression || typeof expression !== "string") return false;
  const clean = expression.replaceAll("(", "").replaceAll(")", "").trim();
  if (clean.includes(" OR ")) {
    return clean.split(" OR ").some((part) => licenseAllowed(part, allowSet));
  }
  if (clean.includes(" AND ")) {
    return clean.split(" AND ").every((part) => licenseAllowed(part, allowSet));
  }
  return allowSet.has(clean);
}

function violations(report, allowSet) {
  const bad = [];
  for (const packages of Object.values(report)) {
    for (const pkg of packages) {
      if (!licenseAllowed(pkg.license, allowSet)) {
        bad.push(`${pkg.name}@${(pkg.versions ?? []).join(",")}: ${pkg.license}`);
      }
    }
  }
  return bad;
}

function selfTest() {
  const pass = JSON.parse(readFileSync(resolve(root, "fixtures/licenses/js-pass.json"), "utf8"));
  const fail = JSON.parse(readFileSync(resolve(root, "fixtures/licenses/js-fail.json"), "utf8"));
  if (violations(pass, APP_ALLOW).length !== 0) {
    throw new Error("JS license self-test failed: pass fixture was rejected");
  }
  const rejected = violations(fail, APP_ALLOW);
  if (rejected.length !== 1 || !rejected[0].includes("BUSL-1.1")) {
    throw new Error("JS license self-test failed: BUSL-1.1 fixture was not rejected");
  }
  console.log("JS license self-test passed (permissive fixture accepted, BUSL-1.1 rejected)");
}

selfTest();

// Whole-workspace production dependency audit via pnpm's built-in checker.
const result = spawnSync("pnpm", ["licenses", "list", "--prod", "--json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (result.status !== 0) {
  throw new Error(`pnpm licenses failed:\n${result.stderr}`);
}
const report = result.stdout.trim() ? JSON.parse(result.stdout) : {};
const appViolations = violations(report, APP_ALLOW);
if (appViolations.length > 0) {
  throw new Error(
    `Incompatible runtime licenses (see CONTRIBUTING.md for the review path):\n${appViolations.join("\n")}`,
  );
}
const audited = Object.values(report).reduce((n, pkgs) => n + pkgs.length, 0);
console.log(`ok - app scope: ${audited} production packages are AGPL-compatible`);

// MIT scopes: direct runtime deps must be permissive.
for (const scope of MIT_SCOPES) {
  const manifest = JSON.parse(readFileSync(resolve(root, scope, "package.json"), "utf8"));
  const deps = Object.keys(manifest.dependencies ?? {});
  const index = new Map(
    Object.values(report)
      .flat()
      .map((pkg) => [pkg.name, pkg.license]),
  );
  const bad = deps.filter((dep) => !licenseAllowed(index.get(dep) ?? "", MIT_SCOPE_ALLOW));
  if (bad.length > 0) {
    throw new Error(`${scope} (MIT scope) has non-permissive runtime deps: ${bad.join(", ")}`);
  }
  console.log(`ok - ${scope}: ${deps.length} direct runtime deps, all permissive (MIT scope)`);
}

console.log("JS license audit passed");
