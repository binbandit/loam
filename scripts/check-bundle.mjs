import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

// §5.9 startup discipline: the cold path must not include heavy feature modules.
// Their loaders must be route-level code-split when they arrive (E17/E22/E23).
const FORBIDDEN = [/katex/i, /mermaid/i, /shiki/i, /pixi/i, /d3-force/i, /xyflow/i, /\.canvas\b/i];

const root = resolve(import.meta.dirname, "..");
const assetsDir = join(root, "apps/desktop/dist/assets");

let files;
try {
  files = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
} catch {
  throw new Error("No built assets found. Run `pnpm --filter @loam-app/desktop build` first.");
}
if (files.length === 0) {
  throw new Error(`No JavaScript assets in ${assetsDir}`);
}

const failures = [];
let totalBytes = 0;
let totalGzipBytes = 0;
for (const file of files) {
  const source = readFileSync(join(assetsDir, file), "utf8");
  totalBytes += statSync(join(assetsDir, file)).size;
  totalGzipBytes += gzipSync(source).length;
  for (const pattern of FORBIDDEN) {
    if (pattern.test(source)) {
      failures.push(`${file}: contains forbidden cold-path module marker ${pattern}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Bundle check failed (§5.9 startup discipline):\n${failures.join("\n")}`);
}
console.log(
  `Bundle check passed: ${files.length} JS asset(s), ${totalBytes} bytes raw, ${totalGzipBytes} bytes gzipped; no KaTeX/Mermaid/Shiki/graph/canvas modules on the cold path`,
);
