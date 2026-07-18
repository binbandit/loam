// Case-aware product rename (§9.4). Invoked via scripts/rename.sh.
//
//   scripts/rename.sh <NewName>            dry run: report every planned substitution
//   scripts/rename.sh <NewName> --apply    perform the rename
//   scripts/rename.sh --self-test          reversible fixture verification (used by CI)
//
// The current product name is read from the root package.json, so a rename is
// reversible by running the script again with the old name.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const NAME_RULE = /^[A-Z][a-zA-Z0-9]{1,29}$/;

export function deriveForms(displayName) {
  return {
    display: displayName,
    lower: displayName.toLowerCase(),
    upper: displayName.toUpperCase(),
  };
}

/**
 * Case-aware, boundary-aware patterns for one name form. Boundaries are chosen so
 * identifiers (`loam-core`, `--loam-accent`, `loam://`, `.loam/`, `com.loam.app`,
 * `LOAM_VERSION`, `LoamCore`) match while unrelated words (`loamy`, `Gloam`,
 * `reloading`) never do.
 */
export function patternsFor(forms) {
  return [
    { kind: "display", regex: new RegExp(`(?<![A-Za-z])${forms.display}(?![a-z])`, "g") },
    { kind: "lower", regex: new RegExp(`(?<![A-Za-z])${forms.lower}(?![a-z])`, "g") },
    { kind: "upper", regex: new RegExp(`(?<![A-Za-z])${forms.upper}(?![A-Z])`, "g") },
  ];
}

export function validateNewName(name, currentDisplay) {
  if (!name || !NAME_RULE.test(name)) {
    throw new Error(
      `Invalid name "${name ?? ""}": must match ${NAME_RULE} (single capitalized alphanumeric word)`,
    );
  }
  if (name.toLowerCase() === currentDisplay.toLowerCase()) {
    throw new Error(`"${name}" is already the product name`);
  }
  return name;
}

function isBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

function listFiles(repoRoot) {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}

export function planRename(repoRoot, newDisplay, { apply }) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const currentLower = manifest.name;
  const current = deriveForms(currentLower.charAt(0).toUpperCase() + currentLower.slice(1));
  const next = deriveForms(validateNewName(newDisplay, current.display));
  const patterns = patternsFor(current);
  const substitute = (text) =>
    patterns.reduce(
      (acc, p) => acc.replaceAll(p.regex, next[p.kind === "display" ? "display" : p.kind]),
      text,
    );

  const report = [];
  let totalMatches = 0;
  // Every path prefix (directories and the file itself) whose basename changes.
  const pathMoves = new Map();

  for (const file of listFiles(repoRoot)) {
    const absolute = resolve(repoRoot, file);
    if (!absolute.startsWith(resolve(repoRoot) + sep)) {
      throw new Error(`Refusing to touch a path outside the repository: ${file}`);
    }
    if (!existsSync(absolute)) continue;
    const buffer = readFileSync(absolute);
    if (!isBinary(buffer)) {
      const text = buffer.toString("utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        const replaced = substitute(line);
        if (replaced !== line) {
          const count = patterns.reduce((n, p) => n + (line.match(p.regex)?.length ?? 0), 0);
          totalMatches += count;
          report.push(`${file}:${i + 1}: ${line.trim()} -> ${replaced.trim()}`);
        }
      });
      const newText = substitute(text);
      if (apply && newText !== text) writeFileSync(absolute, newText);
    }
    const segments = file.split("/");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const prefix = segments.slice(0, depth).join("/");
      const base = segments[depth - 1] ?? "";
      const newBase = substitute(base);
      if (newBase !== base) {
        pathMoves.set(prefix, join(dirname(prefix), newBase));
      }
    }
  }

  // Deepest paths first so children move before their parent directories.
  const pathRenames = [...pathMoves.entries()]
    .map(([from, to]) => ({ from, to }))
    .sort(
      (a, b) =>
        b.from.split("/").length - a.from.split("/").length || b.from.length - a.from.length,
    );
  for (const move of pathRenames) {
    report.push(`rename: ${move.from} -> ${move.to}`);
    if (apply) {
      mkdirSync(dirname(resolve(repoRoot, move.to)), { recursive: true });
      renameSync(resolve(repoRoot, move.from), resolve(repoRoot, move.to));
    }
  }

  return { current, next, report, totalMatches, pathRenames };
}

// ---------------------------------------------------------------------------

function selfTest() {
  const fixture = mkdtempSync(join(tmpdir(), "loam-rename-"));
  const git = (...args) => execFileSync("git", args, { cwd: fixture, encoding: "utf8" });
  try {
    // Miniature repo exercising every §9.4 form + decoys + a binary.
    const files = {
      "package.json": '{ "name": "loam", "version": "0.0.0" }\n',
      "src/app.ts": [
        'export const APP_NAME = "Loam";',
        'export const LOAM_URI_SCHEME = "loam://open?vault=x";',
        'import "@loam-app/ui";',
        'const css = "var(--loam-accent)";',
        'const bundleId = "com.loam.desktop";',
        'const configDir = ".loam/settings.json";',
        'const crate = "loam-core";',
        "export class LoamCore {}",
      ].join("\n"),
      "loam-core/lib.rs": 'pub const APP: &str = "Loam";\n',
      "README.md": "Loam rules. Decoys: reloading, loamy soil, Gloam, LOAMY.\n",
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      writeFileSync(join(fixture, file), content);
    }
    const binary = Buffer.concat([Buffer.from([0x89, 0x50, 0x00, 0x1a]), Buffer.from("loam")]);
    mkdirSync(join(fixture, "assets"));
    writeFileSync(join(fixture, "assets/logo.bin"), binary);
    git("init", "--quiet");

    const snapshot = Object.fromEntries(
      Object.keys(files).map((f) => [f, readFileSync(join(fixture, f), "utf8")]),
    );

    // Invalid names must fail before any write.
    for (const bad of ["", "zephyr", "New Name", "Zephyr!", "Loam"]) {
      let rejected = false;
      try {
        planRename(fixture, bad, { apply: true });
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error(`Self-test failed: name "${bad}" was not rejected`);
    }
    if (readFileSync(join(fixture, "src/app.ts"), "utf8") !== snapshot["src/app.ts"]) {
      throw new Error("Self-test failed: invalid name mutated files");
    }

    // Dry run must not modify anything.
    const dry = planRename(fixture, "Zephyr", { apply: false });
    if (dry.totalMatches === 0) throw new Error("Self-test failed: dry run found nothing");
    if (readFileSync(join(fixture, "src/app.ts"), "utf8") !== snapshot["src/app.ts"]) {
      throw new Error("Self-test failed: dry run modified files");
    }

    // Apply Loam -> Zephyr.
    planRename(fixture, "Zephyr", { apply: true });
    const renamed = readFileSync(join(fixture, "src/app.ts"), "utf8");
    for (const expected of [
      '"Zephyr"',
      "ZEPHYR_URI_SCHEME",
      "zephyr://open",
      "@zephyr-app/ui",
      "--zephyr-accent",
      "com.zephyr.desktop",
      ".zephyr/settings.json",
      "zephyr-core",
      "class ZephyrCore",
    ]) {
      if (!renamed.includes(expected)) {
        throw new Error(`Self-test failed: expected "${expected}" after rename`);
      }
    }
    if (/(?<![A-Za-z])(loam|Loam|LOAM)(?![a-z])/.test(renamed)) {
      throw new Error("Self-test failed: old identifiers remain in src/app.ts");
    }
    const readme = readFileSync(join(fixture, "README.md"), "utf8");
    if (!/reloading, loamy soil, Gloam, LOAMY/.test(readme)) {
      throw new Error("Self-test failed: unrelated decoy words were modified");
    }
    if (!readFileSync(join(fixture, "assets/logo.bin")).equals(binary)) {
      throw new Error("Self-test failed: binary file was modified");
    }
    if (!existsSync(join(fixture, "zephyr-core/lib.rs"))) {
      throw new Error("Self-test failed: directory was not renamed");
    }

    // Reverse Zephyr -> Loam and require byte-identical text files.
    planRename(fixture, "Loam", { apply: true });
    for (const [file, content] of Object.entries(snapshot)) {
      if (readFileSync(join(fixture, file), "utf8") !== content) {
        throw new Error(`Self-test failed: ${file} did not round-trip byte-identically`);
      }
    }
    if (!existsSync(join(fixture, "loam-core/lib.rs"))) {
      throw new Error("Self-test failed: directory rename did not round-trip");
    }
    console.log(
      "Rename self-test passed (all forms substituted, decoys and binaries untouched, round-trip byte-identical, invalid names rejected)",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === "--self-test") {
  selfTest();
} else {
  const apply = args.includes("--apply");
  const name = args.find((a) => !a.startsWith("--"));
  const repoRoot = resolve(import.meta.dirname, "..");
  const { current, next, report, totalMatches, pathRenames } = planRename(repoRoot, name, {
    apply,
  });
  for (const line of report) console.log(line);
  console.log(
    `${apply ? "Applied" : "Planned"} ${totalMatches} substitutions and ${pathRenames.length} path renames (${current.display} -> ${next.display})`,
  );
  if (!apply) console.log("Dry run only. Re-run with --apply to perform the rename.");
  if (apply)
    console.log(
      "Now run: pnpm install --no-frozen-lockfile && pnpm lint && pnpm test (verify, then commit)",
    );
}
