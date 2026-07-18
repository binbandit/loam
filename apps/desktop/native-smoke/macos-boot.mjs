// macOS native boot smoke (LOA-49). WKWebView has no WebDriver, so page-level
// assertions stay manual (docs/native-smoke-checklist.md) — but boot-level
// verification IS automatable: the app process must stay alive, a real window
// must appear, and a screenshot is captured as reviewable evidence. This probe
// class is what catches "process alive, window blank" regressions (e.g. a
// binary serving devUrl instead of the embedded frontend).
//
//   node native-smoke/macos-boot.mjs [path-to-app-binary]

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const resultsDir = resolve(root, "native-results");
const binary = process.argv[2] ?? resolve(root, "../../target/debug/loam-desktop");

if (process.platform !== "darwin") {
  throw new Error("macos-boot.mjs is the macOS leg; use smoke.mjs elsewhere");
}
if (!existsSync(binary)) {
  throw new Error(`Shell binary not found at ${binary}`);
}

const WINDOW_QUERY = `
import CoreGraphics
import Foundation
Thread.sleep(forTimeInterval: 6)
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
var best: (id: Int, area: Double) = (0, 0)
for window in list {
  guard let owner = window[kCGWindowOwnerName as String] as? String,
    owner == "Loam" || owner == "loam-desktop",
    let number = window[kCGWindowNumber as String] as? Int,
    let bounds = window[kCGWindowBounds as String] as? [String: Double]
  else { continue }
  let area = (bounds["Width"] ?? 0) * (bounds["Height"] ?? 0)
  if area > best.area { best = (number, area) }
}
if best.id != 0 { print("\\(best.id) \\(Int(best.area))") }
`;

let appOutput = "";
const app = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
app.stdout.on("data", (chunk) => {
  appOutput += chunk.toString();
});
app.stderr.on("data", (chunk) => {
  appOutput += chunk.toString();
});
let exited = null;
app.on("exit", (code, signal) => {
  exited = { code, signal };
});

function fail(message) {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(
    resolve(resultsDir, "macos-boot.txt"),
    `${message}\nexited: ${JSON.stringify(exited)}\n--- app output ---\n${appOutput}`,
  );
  app.kill();
  console.error(`${message} (artifacts in ${resultsDir})`);
  process.exit(1);
}

// The swift probe itself waits 6s before listing windows.
const swiftFile = join(tmpdir(), `loam-winid-${process.pid}.swift`);
writeFileSync(swiftFile, WINDOW_QUERY);
const probe = spawnSync("swift", [swiftFile], { encoding: "utf8", timeout: 120_000 });
if (exited !== null) {
  fail(`app exited during boot window: ${JSON.stringify(exited)}`);
}
const [windowId, area] = (probe.stdout ?? "").trim().split(" ");
if (!windowId) {
  fail("no on-screen Loam window found after 6s");
}
if (Number(area) < 640 * 480) {
  fail(`Loam window is implausibly small (${area} px^2)`);
}

mkdirSync(resultsDir, { recursive: true });
const screenshot = resolve(resultsDir, "macos-boot.png");
const capture = spawnSync("screencapture", ["-x", "-l", windowId, screenshot]);
if (capture.status !== 0 || !existsSync(screenshot)) {
  fail("window screenshot failed");
}

app.kill();
console.log(
  `macos boot smoke passed: process alive, window ${windowId} (${area} px^2) on screen; screenshot at ${screenshot}`,
);
