#!/usr/bin/env node

/**
 * Visual regression for packages/ui stories (LOA-53, §5.12).
 *
 * Builds the Ladle story host, renders every story in dark and light with
 * Playwright Chromium, and compares pixels against the committed baselines
 * in packages/ui/visual-baselines/. Failures write actual + diff PNGs to
 * packages/ui/visual-artifacts/ (uploaded by CI).
 *
 * Determinism: fixed 720x480 viewport, deviceScaleFactor 1, reduced motion
 * emulated (animations frozen), bundled fonts awaited via document.fonts.
 *
 * Usage:
 *   node scripts/visual-regression.mjs             # compare against baselines
 *   LOAM_UPDATE_FIXTURES=1 node scripts/... [--update]   # (re)write baselines
 *   node scripts/visual-regression.mjs --determinism     # capture twice, compare hashes
 *   node scripts/visual-regression.mjs --self-test       # prove a diff fails + writes artifacts
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const uiRoot = join(root, "packages/ui");
const buildDir = join(uiRoot, "build");
const baselineDir = join(uiRoot, "visual-baselines");
const artifactDir = join(uiRoot, "visual-artifacts");

const update = process.argv.includes("--update") || process.env.LOAM_UPDATE_FIXTURES === "1";
const determinism = process.argv.includes("--determinism");
const selfTest = process.argv.includes("--self-test");

const THEMES = ["dark", "light"];
const VIEWPORT = { width: 720, height: 480 };
// Antialiasing wobble tolerance: pixelmatch threshold + allowed ratio.
const PIXEL_THRESHOLD = 0.2;
const MAX_MISMATCH_RATIO = 0.005;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function buildLadle() {
  log("Building Ladle story host…");
  execFileSync("pnpm", ["--filter", "@loam-app/ui", "exec", "ladle", "build"], {
    cwd: root,
    stdio: "inherit",
  });
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serve(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    let file = join(dir, path === "/" ? "index.html" : path);
    if (!existsSync(file)) file = join(dir, "index.html");
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolvePort) => {
    server.listen(0, "127.0.0.1", () => resolvePort({ server, port: server.address().port }));
  });
}

function storyIds() {
  const meta = JSON.parse(readFileSync(join(buildDir, "meta.json"), "utf8"));
  return Object.keys(meta.stories).sort();
}

async function captureStory(page, port, story, theme, perturb = false) {
  const url = `http://127.0.0.1:${port}/?story=${story}&mode=preview&theme=${theme}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  await page.evaluate(async () => {
    document.getElementById("ladle-root")?.style.setProperty("padding", "16px");
    await document.fonts.ready;
  });
  if (perturb) {
    // Inverting the whole page guarantees a viewport-wide change no matter
    // how sparse the story is.
    await page.addStyleTag({ content: "body { filter: invert(1); }" });
  }
  // Two frames so entrance transitions (80ms under reduced motion) settle.
  await page.waitForTimeout(250);
  return page.screenshot({ fullPage: false });
}

function compare(name, actualBuffer) {
  const baselinePath = join(baselineDir, `${name}.png`);
  if (!existsSync(baselinePath)) {
    return { status: "missing" };
  }
  const baseline = PNG.sync.read(readFileSync(baselinePath));
  const actual = PNG.sync.read(actualBuffer);
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return { status: "size-mismatch", baseline };
  }
  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const mismatched = pixelmatch(
    baseline.data,
    actual.data,
    diff.data,
    baseline.width,
    baseline.height,
    {
      threshold: PIXEL_THRESHOLD,
    },
  );
  const ratio = mismatched / (baseline.width * baseline.height);
  return ratio > MAX_MISMATCH_RATIO
    ? { status: "diff", mismatched, ratio, diff }
    : { status: "ok", mismatched, ratio };
}

function writeArtifacts(name, actualBuffer, result) {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, `${name}.actual.png`), actualBuffer);
  if (result.diff) {
    writeFileSync(join(artifactDir, `${name}.diff.png`), PNG.sync.write(result.diff));
  }
}

async function main() {
  buildLadle();
  const stories = storyIds();
  log(`${stories.length} stories × ${THEMES.length} themes`);
  rmSync(artifactDir, { recursive: true, force: true });
  if (update) mkdirSync(baselineDir, { recursive: true });

  const { server, port } = await serve(buildDir);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    colorScheme: "dark",
  });
  const page = await context.newPage();

  const failures = [];
  let compared = 0;
  try {
    for (const story of stories) {
      for (const theme of THEMES) {
        const name = `${story}--${theme}`;
        const shot = await captureStory(page, port, story, theme);
        if (determinism) {
          const again = await captureStory(page, port, story, theme);
          const [a, b] = [shot, again].map((buffer) =>
            createHash("sha256").update(buffer).digest("hex"),
          );
          if (a !== b) failures.push(`${name}: nondeterministic capture (${a} != ${b})`);
          compared += 1;
          continue;
        }
        if (update) {
          writeFileSync(join(baselineDir, `${name}.png`), shot);
          compared += 1;
          continue;
        }
        const result = compare(name, shot);
        compared += 1;
        if (result.status === "ok") continue;
        writeArtifacts(name, shot, result);
        failures.push(
          result.status === "diff"
            ? `${name}: ${result.mismatched}px differ (${(result.ratio * 100).toFixed(2)}%)`
            : `${name}: ${result.status} — run \`pnpm visual:update\` and review`,
        );
      }
    }

    if (selfTest && !update && !determinism) {
      // AC4: a forced perturbation must fail and produce a reviewable diff.
      const story = stories[0];
      const name = `${story}--dark`;
      const shot = await captureStory(page, port, story, "dark", true);
      const result = compare(name, shot);
      if (result.status !== "diff" && result.status !== "size-mismatch") {
        failures.push("self-test: perturbed capture unexpectedly matched the baseline");
      } else {
        writeArtifacts(`self-test-${name}`, shot, result);
        if (!existsSync(join(artifactDir, `self-test-${name}.actual.png`))) {
          failures.push("self-test: failure artifacts were not written");
        } else {
          log(
            `self-test ok: perturbation detected (${result.mismatched ?? "size"}px), diff artifact written`,
          );
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length > 0) {
    for (const failure of failures) log(`FAIL ${failure}`);
    log(
      `Visual regression FAILED (${failures.length} of ${compared}); artifacts in ${artifactDir}`,
    );
    process.exit(1);
  }
  log(
    determinism
      ? `Determinism check passed (${compared} captures hashed twice)`
      : update
        ? `Baselines written (${compared}) to ${baselineDir}`
        : `Visual regression passed (${compared} snapshots)`,
  );
}

await main();
