import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outDir = join(root, "dist", "artifacts");

const OS_NAMES = { darwin: "macos", win32: "windows", linux: "linux" };

/** loam-<kind>-dev-<os>-<arch>-<sha> — must be unique per (os, arch, commit). */
export function artifactName(kind, os, arch, sha) {
  for (const [label, value] of Object.entries({ kind, os, arch, sha })) {
    if (!/^[a-z0-9-]+$/.test(value)) {
      throw new Error(`Invalid ${label} for artifact name: "${value}"`);
    }
  }
  return `loam-${kind}-dev-${os}-${arch}-${sha}`;
}

// Name self-check: every (os, arch) pair in the support matrix must yield a
// distinct name for the same commit, and distinct commits must never collide.
function selfTestNames() {
  const names = new Set();
  for (const os of ["macos", "windows", "linux"]) {
    for (const arch of ["x64", "arm64"]) {
      for (const sha of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) {
        names.add(artifactName("web", os, arch, sha));
      }
    }
  }
  if (names.size !== 12) {
    throw new Error("Artifact name self-test failed: names are not unique across the matrix");
  }
}
selfTestNames();

const os = OS_NAMES[process.platform] ?? process.platform;
const arch = process.arch;
const sha = (
  process.env.GITHUB_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
).slice(0, 12);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const artifacts = [];

// Web bundle: already real (LOA-8's Vite entry), so ship it as a dev artifact.
const build = spawnSync("pnpm", ["--filter", "@loam-app/desktop", "build"], {
  cwd: root,
  stdio: "inherit",
  // pnpm is a .cmd shim on Windows, resolvable only through a shell.
  shell: process.platform === "win32",
});
if (build.status !== 0) process.exit(build.status ?? 1);
const webName = `${artifactName("web", os, arch, sha)}.tar.gz`;
const tar = spawnSync(
  "tar",
  ["czf", join(outDir, webName), "-C", join(root, "apps/desktop/dist"), "."],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (tar.status !== 0) process.exit(tar.status ?? 1);
artifacts.push({
  file: webName,
  kind: "web-bundle",
  status: "built",
  bytes: statSync(join(outDir, webName)).size,
});

// Native desktop bundle: real since LOA-21 landed the Tauri shell. Unsigned
// development bundles only; signing/notarization is E26.
const tauriConf = join(root, "apps/desktop/src-tauri/tauri.conf.json");
if (existsSync(tauriConf)) {
  const native = spawnSync("pnpm", ["--filter", "@loam-app/desktop", "exec", "tauri", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (native.status !== 0) process.exit(native.status ?? 1);
  const bundleRoot = join(root, "target", "release", "bundle");
  const bundleExtensions = [".dmg", ".deb", ".rpm", ".AppImage", ".msi", ".exe"];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.endsWith(".app")) walk(path);
      else if (entry.isFile() && bundleExtensions.some((ext) => entry.name.endsWith(ext))) {
        found.push(path);
      }
    }
  };
  walk(bundleRoot);
  if (found.length === 0) {
    throw new Error(`tauri build succeeded but no bundles were found under ${bundleRoot}`);
  }
  for (const bundle of found) {
    const ext = bundle.slice(bundle.lastIndexOf("."));
    const kindSuffix = ext.slice(1).toLowerCase();
    const name = `${artifactName(`desktop-${kindSuffix}`, os, arch, sha)}${ext}`;
    copyFileSync(bundle, join(outDir, name));
    artifacts.push({
      file: name,
      kind: "desktop-bundle",
      status: "built",
      bytes: statSync(join(outDir, name)).size,
    });
  }
} else {
  const markerName = `${artifactName("desktop", os, arch, sha)}.skipped.json`;
  const marker = {
    status: "skipped",
    reason: "E01 dependency: Tauri shell not yet present (apps/desktop/src-tauri/tauri.conf.json)",
    os,
    arch,
    commit: sha,
  };
  writeFileSync(join(outDir, markerName), `${JSON.stringify(marker, null, 2)}\n`);
  artifacts.push({
    file: markerName,
    kind: "desktop-bundle",
    status: "skipped",
    bytes: statSync(join(outDir, markerName)).size,
  });
}

// Machine-readable size metadata for later §5.9 budget enforcement (<30 MB installer).
writeFileSync(
  join(outDir, "metadata.json"),
  `${JSON.stringify({ commit: sha, os, arch, artifacts }, null, 2)}\n`,
);
for (const a of artifacts) {
  console.log(`${a.status} - ${a.file} (${a.bytes} bytes)`);
}
console.log(`Artifact metadata written to dist/artifacts/metadata.json`);
