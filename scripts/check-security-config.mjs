import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Structural enforcement of the §5.10 trust boundary (LOA-36). The runtime
// negative tests (out-of-scope fs read, blocked fetch) land with the
// tauri-driver harness in LOA-49; this gate guarantees the *shipped surface*
// can never grant those abilities in the first place.

const root = resolve(import.meta.dirname, "..");
const shellDir = join(root, "apps/desktop/src-tauri");
const failures = [];

// 1. Capabilities: no fs, shell, process, or open-URL powers; explicit platforms.
const capsDir = join(shellDir, "capabilities");
const forbiddenPermission = /(shell|process|^fs:|\bfs:|opener|http:|updater)/i;
const capabilityFiles = readdirSync(capsDir).filter((f) => f.endsWith(".json"));
if (capabilityFiles.length === 0) failures.push("no capability manifests found");
for (const file of capabilityFiles) {
  const capability = JSON.parse(readFileSync(join(capsDir, file), "utf8"));
  for (const permission of capability.permissions ?? []) {
    const id = typeof permission === "string" ? permission : permission.identifier;
    if (forbiddenPermission.test(id)) {
      failures.push(`${file}: forbidden permission "${id}"`);
    }
    if (!id.startsWith("core:")) {
      failures.push(`${file}: non-core permission "${id}" requires a security review`);
    }
  }
  const platforms = capability.platforms ?? [];
  const expected = ["macOS", "windows", "linux"];
  if (expected.some((p) => !platforms.includes(p)) || platforms.length !== expected.length) {
    failures.push(`${file}: platforms must be exactly ${expected.join("/")} (identical policy)`);
  }
}

// 2. No shell/fs/process plugin crates in the shell.
const cargo = readFileSync(join(shellDir, "Cargo.toml"), "utf8");
for (const banned of ["tauri-plugin-shell", "tauri-plugin-fs", "tauri-plugin-process"]) {
  if (cargo.includes(banned)) failures.push(`src-tauri/Cargo.toml: ${banned} must not ship`);
}

// 3. CSP: present, default-deny, no remote origins outside the IPC bridge (dev
//    CSP may additionally reach the localhost Vite server).
const conf = JSON.parse(readFileSync(join(shellDir, "tauri.conf.json"), "utf8"));
const allowedSources = {
  csp: new Set(["'self'", "'none'", "data:", "ipc:", "http://ipc.localhost"]),
  devCsp: new Set([
    "'self'",
    "'none'",
    "'unsafe-inline'",
    "data:",
    "ipc:",
    "http://ipc.localhost",
    "ws://localhost:5173",
    "http://localhost:5173",
  ]),
};
for (const [key, allowed] of Object.entries(allowedSources)) {
  const csp = conf.app?.security?.[key];
  if (!csp || typeof csp !== "object") {
    failures.push(`tauri.conf.json: security.${key} must be an explicit policy object`);
    continue;
  }
  if (csp["default-src"] !== "'self'") {
    failures.push(`tauri.conf.json: ${key} default-src must be 'self'`);
  }
  for (const [directive, value] of Object.entries(csp)) {
    for (const source of String(value).split(/\s+/)) {
      if (!allowed.has(source)) {
        failures.push(`tauri.conf.json: ${key} ${directive} has unapproved source "${source}"`);
      }
    }
  }
}
if (conf.app?.security?.assetProtocol?.enable !== false) {
  failures.push(
    "tauri.conf.json: assetProtocol must stay disabled until scoped by a reviewed change",
  );
}

if (failures.length > 0) {
  throw new Error(`Security config check failed (§5.10):\n${failures.join("\n")}`);
}
console.log(
  `Security config check passed (${capabilityFiles.length} capability manifest(s), CSP default-deny, no shell/fs/process surface)`,
);
