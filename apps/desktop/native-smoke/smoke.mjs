// Native shell smoke (LOA-49, §5.12): drives the packaged development shell
// through tauri-driver on Windows/Linux using the raw W3C WebDriver protocol
// (no dependencies). macOS has no WKWebView WebDriver support — that accepted
// gap is covered by docs/native-smoke-checklist.md.
//
//   node native-smoke/smoke.mjs [path-to-binary] [--expect-fail]
//
// --expect-fail asserts against a bogus test ID to prove the failure-artifact
// path (screenshot + page source + driver log) actually captures evidence.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DRIVER_PORT = 4445;
const READY_TIMEOUT_MS = 30_000;
const root = resolve(import.meta.dirname, "..");
const resultsDir = resolve(root, "native-results");

const args = process.argv.slice(2);
const expectFail = args.includes("--expect-fail");
const binary =
  args.find((a) => !a.startsWith("--")) ??
  resolve(
    root,
    "../../target/release/",
    process.platform === "win32" ? "loam-desktop.exe" : "loam-desktop",
  );

if (!existsSync(binary)) {
  throw new Error(
    `Shell binary not found at ${binary}. Build it first (cargo build --release -p loam-desktop).`,
  );
}

const driverLog = [];
const driverArgs = ["--port", String(DRIVER_PORT)];
// GitHub's Windows runners expose the matching Edge WebDriver via EDGEWEBDRIVER.
if (process.platform === "win32" && process.env.EDGEWEBDRIVER) {
  driverArgs.push("--native-driver", resolve(process.env.EDGEWEBDRIVER, "msedgedriver.exe"));
}
const driver = spawn("tauri-driver", driverArgs, { stdio: ["ignore", "pipe", "pipe"] });
driver.stdout.on("data", (chunk) => driverLog.push(chunk.toString()));
driver.stderr.on("data", (chunk) => driverLog.push(chunk.toString()));

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function webdriver(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${DRIVER_PORT}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${JSON.stringify(json.value ?? json)}`);
  }
  return json.value;
}

let sessionId = null;

async function captureFailureArtifacts(error) {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(resolve(resultsDir, "error.txt"), String(error?.stack ?? error));
  writeFileSync(resolve(resultsDir, "tauri-driver.log"), driverLog.join(""));
  if (sessionId) {
    try {
      const screenshot = await webdriver("GET", `/session/${sessionId}/screenshot`);
      writeFileSync(resolve(resultsDir, "failure.png"), Buffer.from(screenshot, "base64"));
      const source = await webdriver("GET", `/session/${sessionId}/source`);
      writeFileSync(resolve(resultsDir, "page-source.html"), source);
    } catch (captureError) {
      writeFileSync(resolve(resultsDir, "capture-error.txt"), String(captureError));
    }
  }
  console.error(`Failure artifacts written to ${resultsDir}`);
}

async function findReadyMain(testId) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = new Error("never attempted");
  while (Date.now() < deadline) {
    try {
      const element = await webdriver("POST", `/session/${sessionId}/element`, {
        using: "css selector",
        value: `[data-testid=${testId}][data-ready=true]`,
      });
      return element;
    } catch (error) {
      lastError = error;
      await wait(500);
    }
  }
  throw new Error(`app never became ready (${testId}): ${lastError.message}`);
}

try {
  // tauri-driver needs a moment to bind its port.
  let up = false;
  for (let attempt = 0; attempt < 20 && !up; attempt += 1) {
    up = await fetch(`http://127.0.0.1:${DRIVER_PORT}/status`)
      .then((r) => r.ok)
      .catch(() => false);
    if (!up) await wait(500);
  }
  if (!up) throw new Error("tauri-driver did not start");

  const session = await webdriver("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application: binary } } },
  });
  sessionId = session.sessionId;

  const title = await webdriver("GET", `/session/${sessionId}/title`);
  if (title !== "Loam") throw new Error(`unexpected window title: ${title}`);

  await findReadyMain(expectFail ? "does-not-exist" : "app-main");

  await webdriver("DELETE", `/session/${sessionId}`);
  sessionId = null;
  console.log("native smoke passed: app launched, rendered ready, and closed");
  process.exit(0);
} catch (error) {
  await captureFailureArtifacts(error);
  if (expectFail) {
    const artifactsExist =
      existsSync(resolve(resultsDir, "failure.png")) &&
      existsSync(resolve(resultsDir, "tauri-driver.log"));
    if (sessionId) await webdriver("DELETE", `/session/${sessionId}`).catch(() => {});
    if (artifactsExist) {
      console.log("expected-failure fixture passed: artifacts captured");
      process.exit(0);
    }
    console.error("expected-failure fixture FAILED: artifacts missing");
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
} finally {
  driver.kill();
}
