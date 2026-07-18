import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// §5.12 coverage gates. A scope is skipped (with a notice) only while it has no
// coverage report at all; once a report exists the threshold is enforced.
const gates = [
  {
    scope: "loam-core",
    threshold: 85,
    report: "coverage/rust-summary.json",
    read: (json) => json.data[0].totals.lines.percent,
  },
  {
    scope: "@loam-app/ui",
    threshold: 80,
    report: "packages/ui/coverage/coverage-summary.json",
    read: (json) => json.total.lines.pct,
  },
];

export function evaluate(scope, threshold, linePercent) {
  if (typeof linePercent !== "number" || Number.isNaN(linePercent)) {
    return `${scope}: coverage report is malformed (line percentage missing)`;
  }
  if (linePercent < threshold) {
    return `${scope}: line coverage ${linePercent.toFixed(2)}% is below the ${threshold}% gate`;
  }
  return null;
}

function selfTest() {
  const fixtures = [
    { file: "fixtures/coverage/pass-summary.json", expectFailure: false },
    { file: "fixtures/coverage/fail-summary.json", expectFailure: true },
  ];
  for (const { file, expectFailure } of fixtures) {
    const json = JSON.parse(readFileSync(resolve(root, file), "utf8"));
    const failure = evaluate("@loam-app/ui", 80, json.total.lines.pct);
    if (Boolean(failure) !== expectFailure) {
      throw new Error(`Coverage gate self-test failed for ${file}: got ${failure ?? "pass"}`);
    }
  }
  console.log("Coverage gate self-test passed (pass fixture accepted, fail fixture rejected)");
}

selfTest();

const failures = [];
let enforced = 0;
for (const gate of gates) {
  let json;
  try {
    json = JSON.parse(readFileSync(resolve(root, gate.report), "utf8"));
  } catch {
    console.log(`note - ${gate.scope}: no report at ${gate.report}; run \`pnpm coverage\` first`);
    continue;
  }
  enforced += 1;
  const failure = evaluate(gate.scope, gate.threshold, gate.read(json));
  if (failure) {
    failures.push(failure);
  } else {
    console.log(`ok - ${gate.scope}: line coverage meets the ${gate.threshold}% gate`);
  }
}

if (failures.length > 0) {
  throw new Error(`Coverage gates failed:\n${failures.join("\n")}`);
}
console.log(`Coverage check passed (${enforced} of ${gates.length} scopes had reports)`);
