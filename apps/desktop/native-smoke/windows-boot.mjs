// Windows native boot smoke (LOA-49). The full WebDriver leg is blocked by an
// msedgedriver↔WebView2 attach hang inside the tauri-driver chain (session
// creation never completes despite a booting, rendering app, matched driver,
// and correct webviewOptions capabilities — see tauri-apps/tauri#9653 and the
// LOA-49 evidence trail). Until that upstream path stabilizes, Windows runs at
// the same boot tier as macOS: process alive + real titled window on screen +
// screenshot artifact. Re-attempt the WebDriver leg with
// LOAM_SMOKE_WEBDRIVER=1 (runs smoke.mjs instead).
//
//   node native-smoke/windows-boot.mjs [path-to-app-binary]

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const resultsDir = resolve(root, "native-results");
const binary = process.argv[2] ?? resolve(root, "../../target/debug/loam-desktop.exe");

if (process.platform !== "win32") {
  throw new Error("windows-boot.mjs is the Windows leg; use smoke.mjs / macos-boot.mjs elsewhere");
}
if (!existsSync(binary)) {
  throw new Error(`Shell binary not found at ${binary}`);
}

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
    resolve(resultsDir, "windows-boot.txt"),
    `${message}\nexited: ${JSON.stringify(exited)}\n--- app output ---\n${appOutput}`,
  );
  app.kill();
  console.error(`${message} (artifacts in ${resultsDir})`);
  process.exit(1);
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
await wait(6000);

if (exited !== null) {
  fail(`app exited during boot window: ${JSON.stringify(exited)}`);
}

// A real top-level window must exist with the expected title.
const probe = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).MainWindowTitle`,
  ],
  { encoding: "utf8", timeout: 60_000 },
);
const title = (probe.stdout ?? "").trim();
if (title !== "Loam") {
  fail(`expected a window titled "Loam", got "${title}"`);
}

// Screenshot the primary screen as reviewable evidence (runner session only).
mkdirSync(resultsDir, { recursive: true });
const screenshot = resolve(resultsDir, "windows-boot.png");
const captureScript = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save('${screenshot.replaceAll("\\", "\\\\")}')
`;
const capture = spawnSync("powershell", ["-NoProfile", "-Command", captureScript], {
  timeout: 60_000,
});
if (capture.status !== 0 || !existsSync(screenshot)) {
  fail("screen capture failed");
}

app.kill();
console.log(`windows boot smoke passed: process alive, window "Loam" present; screenshot saved`);
