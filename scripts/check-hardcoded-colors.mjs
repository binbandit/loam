/**
 * §4.2 token discipline: components never hardcode colors — every color
 * flows from a `--loam-*` custom property. This walks component sources
 * (default: packages/ui/src) and fails on hex/rgb()/hsl() literals outside
 * the token sheets themselves.
 *
 * Usage: node scripts/check-hardcoded-colors.mjs [targetDir]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, process.argv[2] ?? "packages/ui/src");

// The token sheets are the ONE place raw colors live.
const ALLOWED = [/tokens[\\/](tokens|fonts)\.css$/];
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);
const COLOR_PATTERNS = [
  { pattern: /#[0-9a-fA-F]{3,8}\b/g, label: "hex color" },
  { pattern: /\brgba?\(/g, label: "rgb()/rgba()" },
  { pattern: /\bhsla?\(/g, label: "hsl()/hsla()" },
  { pattern: /\b(?:oklch|lab|lch|color)\(/g, label: "css color function" },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "generated") {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}

const failures = [];
let scanned = 0;
for (const path of walk(target)) {
  const extension = path.slice(path.lastIndexOf("."));
  if (!SCANNED_EXTENSIONS.has(extension)) {
    continue;
  }
  const relativePath = relative(root, path);
  if (ALLOWED.some((allowed) => allowed.test(relativePath))) {
    continue;
  }
  if (relativePath.includes(".test.") || relativePath.endsWith("test-setup.ts")) {
    continue; // tests assert against literal token VALUES by design
  }
  scanned += 1;
  const source = readFileSync(path, "utf8");
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.includes("color-lint-expected")) {
      continue; // documented, justified exception marker
    }
    for (const { pattern, label } of COLOR_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        failures.push(`${relativePath}:${index + 1}: hardcoded ${label} — use a --loam-* token`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`Hardcoded color check failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`Hardcoded color check passed (${scanned} component sources scanned)`);
