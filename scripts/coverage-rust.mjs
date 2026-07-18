import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
mkdirSync(join(root, "coverage"), { recursive: true });

// cargo-llvm-cov needs llvm-profdata/llvm-cov. rustup toolchains ship them via the
// llvm-tools component; Homebrew Rust does not, so fall back to Homebrew LLVM.
const env = { ...process.env };
const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
const host = execFileSync("rustc", ["--version", "--verbose"], { encoding: "utf8" }).match(
  /host: (\S+)/,
)?.[1];
const rustupTools = host ? join(sysroot, "lib", "rustlib", host, "bin", "llvm-profdata") : "";
if (!existsSync(rustupTools)) {
  const brew = spawnSync("brew", ["--prefix", "llvm"], { encoding: "utf8" });
  const prefix = brew.status === 0 ? brew.stdout.trim() : "";
  if (prefix && existsSync(join(prefix, "bin", "llvm-profdata"))) {
    env.LLVM_PROFDATA = join(prefix, "bin", "llvm-profdata");
    env.LLVM_COV = join(prefix, "bin", "llvm-cov");
  } else {
    throw new Error(
      "No llvm-profdata found. Install the rustup llvm-tools component or Homebrew llvm.",
    );
  }
}

const run = (args) => {
  const result = spawnSync("cargo", args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// §5.12 scopes the Rust coverage gate to loam-core.
run([
  "llvm-cov",
  "nextest",
  "-p",
  "loam-core",
  "--json",
  "--summary-only",
  "--output-path",
  "coverage/rust-summary.json",
]);
run(["llvm-cov", "report", "--lcov", "--output-path", "coverage/rust-lcov.info"]);
console.log("Rust coverage written to coverage/rust-summary.json and coverage/rust-lcov.info");
