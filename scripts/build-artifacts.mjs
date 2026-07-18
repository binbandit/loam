import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// Native desktop bundle: blocked on the Tauri shell (E01). Emit an explicit
// dependency marker instead of silently skipping.
const tauriConf = join(root, "apps/desktop/src-tauri/tauri.conf.json");
if (existsSync(tauriConf)) {
  throw new Error(
    "Tauri shell detected (E01 landed): replace this marker path with a real `tauri build` invocation.",
  );
}
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

// Machine-readable size metadata for later §5.9 budget enforcement (<30 MB installer).
writeFileSync(
  join(outDir, "metadata.json"),
  `${JSON.stringify({ commit: sha, os, arch, artifacts }, null, 2)}\n`,
);
for (const a of artifacts) {
  console.log(`${a.status} - ${a.file} (${a.bytes} bytes)`);
}
console.log(`Artifact metadata written to dist/artifacts/metadata.json`);
