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
// tauri-driver's --native-port DEFAULTS to 4445; it must never collide with
// --port or the spawned native driver bind-loops forever (seen on CI).
const NATIVE_DRIVER_PORT = 4446;
const READY_TIMEOUT_MS = 30_000;
// The native driver can spew retry errors endlessly; keep artifacts bounded.
const DRIVER_LOG_LIMIT = 2 * 1024 * 1024;
const root = resolve(import.meta.dirname, "..");
const resultsDir = resolve(root, "native-results");

const args = process.argv.slice(2);
const expectFail = args.includes("--expect-fail");
// Debug build: matches Tauri's canonical WebDriver example, and on Windows the
// debug binary keeps the console subsystem so startup crashes reach stderr.
const binary =
  args.find((a) => !a.startsWith("--")) ??
  resolve(
    root,
    "../../target/debug/",
    process.platform === "win32" ? "loam-desktop.exe" : "loam-desktop",
  );

if (!existsSync(binary)) {
  throw new Error(
    `Shell binary not found at ${binary}. Build it first (cargo build -p loam-desktop).`,
  );
}

// Pre-flight: prove the app boots at all on this runner before involving any
// WebDriver — a driver "session not created" is indistinguishable from an app
// that crashes at startup, so settle that question first with hard evidence.
async function preflightBareLaunch() {
  let appOutput = "";
  const app = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
  app.stdout.on("data", (chunk) => {
    appOutput += chunk.toString();
  });
  app.stderr.on("data", (chunk) => {
    appOutput += chunk.toString();
  });
  const exited = new Promise((resolveExit) => {
    app.on("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const verdict = await Promise.race([
    exited,
    new Promise((resolveAlive) => setTimeout(() => resolveAlive("alive"), 5000)),
  ]);
  if (verdict !== "alive") {
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      resolve(resultsDir, "preflight.txt"),
      `app exited during 5s bare-launch preflight: ${JSON.stringify(verdict)}\n--- output ---\n${appOutput}`,
    );
    throw new Error(
      `preflight failed: the shell exited within 5s (${JSON.stringify(verdict)}); see preflight.txt`,
    );
  }
  app.kill();
  await exited.catch(() => {});
  console.log("preflight passed: shell boots and stays alive bare");
}

let driverLog = "";
const appendDriverLog = (chunk) => {
  driverLog = (driverLog + chunk.toString()).slice(-DRIVER_LOG_LIMIT);
};
const driverArgs = ["--port", String(DRIVER_PORT), "--native-port", String(NATIVE_DRIVER_PORT)];
// Windows needs an msedgedriver matching the WebView2 RUNTIME version.
// LOAM_NATIVE_DRIVER is set by CI (registry-matched download); EDGEWEBDRIVER
// (Edge-matched) is the local-dev fallback.
if (process.platform === "win32") {
  const nativeDriver =
    process.env.LOAM_NATIVE_DRIVER ??
    (process.env.EDGEWEBDRIVER
      ? resolve(process.env.EDGEWEBDRIVER, "msedgedriver.exe")
      : undefined);
  if (nativeDriver) driverArgs.push("--native-driver", nativeDriver);
}
const driver = spawn("tauri-driver", driverArgs, { stdio: ["ignore", "pipe", "pipe"] });
driver.stdout.on("data", appendDriverLog);
driver.stderr.on("data", appendDriverLog);

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function webdriver(method, path, body) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${DRIVER_PORT}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Fail fast instead of undici's 5-minute stall when the driver chain
      // hangs (seen on Linux: session creation never answered).
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    // Attribute timeouts to the exact endpoint; a bare DOMException tells the
    // log reader nothing.
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`${method} ${path} timed out after 60s (driver chain hung)`);
    }
    throw error;
  }
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
  writeFileSync(resolve(resultsDir, "tauri-driver.log"), driverLog);
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
  await preflightBareLaunch();

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
    capabilities: {
      alwaysMatch: {
        // webviewOptions tells msedgedriver to attach to a WebView2 APP;
        // without it the binary is treated as an Edge browser and session
        // creation hangs on Windows (tauri-apps/tauri#9653). Harmless on
        // Linux's WebKitWebDriver.
        "tauri:options": { application: binary, webviewOptions: {} },
        browserName: "wry",
      },
    },
  });
  sessionId = session.sessionId;

  // Wait for the app to render first — the title is empty until the page
  // loads, so asserting it before readiness is a race.
  await findReadyMain(expectFail ? "does-not-exist" : "app-main");

  const title = await webdriver("GET", `/session/${sessionId}/title`);
  if (title !== "Loam") throw new Error(`unexpected window title: ${title}`);

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
