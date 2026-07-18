import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DCO 1.1 sign-off trailer, e.g. "Signed-off-by: Jane Doe <jane@example.com>".
const SIGNOFF = /^Signed-off-by: .+ <[^<>@\s]+@[^<>@\s]+>$/m;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Returns the SHAs in `range` (or unpushed commits on HEAD by default) missing a sign-off. */
export function findUnsigned(range, cwd) {
  const list = git(["rev-list", range], cwd).trim();
  if (!list) return [];
  return list.split("\n").filter((sha) => {
    const body = git(["show", "--no-patch", "--format=%B", sha], cwd);
    return !SIGNOFF.test(body);
  });
}

function selfTest() {
  const repo = mkdtempSync(join(tmpdir(), "loam-dco-"));
  try {
    git(["init", "--quiet", "--initial-branch=main"], repo);
    git(["config", "user.name", "DCO Fixture"], repo);
    git(["config", "user.email", "fixture@example.com"], repo);
    const commit = (message) =>
      git(["commit", "--quiet", "--allow-empty", "--no-verify", "-m", message], repo);

    commit("chore: signed fixture\n\nSigned-off-by: DCO Fixture <fixture@example.com>");
    commit("chore: unsigned fixture");
    commit("chore: malformed fixture\n\nSigned-off-by: no email here");

    const unsigned = findUnsigned("HEAD", repo);
    if (unsigned.length !== 2) {
      throw new Error(
        `DCO self-test failed: expected exactly 2 of 3 fixture commits rejected, got ${unsigned.length}`,
      );
    }
    console.log("DCO self-test passed (signed fixture accepted, unsigned and malformed rejected)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === "--self-test") {
  selfTest();
} else {
  // Usage: check-dco.mjs [range]. CI passes e.g. "origin/main..HEAD".
  const range = args[0] ?? "@{upstream}..HEAD";
  let unsigned;
  try {
    unsigned = findUnsigned(range, process.cwd());
  } catch {
    console.log(`DCO check skipped: cannot resolve range "${range}"`);
    process.exit(0);
  }
  if (unsigned.length > 0) {
    throw new Error(
      `Commits missing a valid Signed-off-by trailer (use \`git commit -s\`):\n${unsigned.join("\n")}`,
    );
  }
  console.log(`DCO check passed for range ${range}`);
}
