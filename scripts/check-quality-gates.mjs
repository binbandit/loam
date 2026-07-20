import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// Each gate runs against a negative fixture and must FAIL, proving the gate
// actually rejects bad input rather than passing vacuously.
const gates = [
  {
    name: "TypeScript strict mode rejects implicit any",
    command: "pnpm",
    args: ["exec", "tsc", "-p", "fixtures/typescript", "--noEmit"],
    expectInOutput: "TS7006",
  },
  {
    name: "rustfmt --check detects unformatted Rust",
    command: "rustfmt",
    args: ["--edition", "2024", "--check", "fixtures/rust/unformatted.rs"],
    expectInOutput: "Diff in",
  },
  {
    name: "cargo-deny rejects licenses outside the allow list",
    command: "cargo",
    args: ["deny", "check", "--config", "fixtures/licenses/deny-fail.toml", "licenses"],
    expectInOutput: "rejected",
  },
  {
    name: "hardcoded-color lint rejects raw colors in components (§4.2)",
    command: "node",
    args: ["scripts/check-hardcoded-colors.mjs", "fixtures/ui"],
    expectInOutput: "hardcoded hex color",
  },
];

const failures = [];
for (const gate of gates) {
  const result = spawnSync(gate.command, gate.args, {
    cwd: root,
    encoding: "utf8",
    // pnpm is a .cmd shim on Windows, resolvable only through a shell.
    shell: process.platform === "win32",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0) {
    failures.push(`${gate.name}: expected a nonzero exit, but the gate passed the bad fixture`);
  } else if (!output.includes(gate.expectInOutput)) {
    failures.push(
      `${gate.name}: failed, but without the expected diagnostic "${gate.expectInOutput}":\n${output}`,
    );
  } else {
    console.log(`ok - ${gate.name}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Quality gates are not enforcing:\n${failures.join("\n")}`);
}

console.log(`Quality-gate check passed (${gates.length} negative fixtures rejected)`);
