import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// §1.5 trademark rule: "Obsidian" and "Linear" may appear only as nominative
// references. Reject copy that implies affiliation, endorsement, or ownership.
const TRADEMARKS = "(?:Obsidian|Linear)";
const prohibited = [
  new RegExp(`(?:affiliated|partnered|endorsed|sponsored)[^.\\n]{0,40}${TRADEMARKS}`, "i"),
  new RegExp(`${TRADEMARKS}[^.\\n]{0,40}(?:affiliated|partnered|endorsed|sponsored)`, "i"),
  new RegExp(`official ${TRADEMARKS}`, "i"),
  new RegExp(`${TRADEMARKS} official`, "i"),
  new RegExp(`${TRADEMARKS}(?:™|®)`),
  /obsidian\.md\/(?!.*nominative)/i,
];

// Sentences that *deny* affiliation are the one allowed context for these words.
const denialContext = /not affiliated|no affiliation|never imply|must never/i;

const root = resolve(import.meta.dirname, "..");
const files = execFileSync(
  "git",
  ["ls-files", "-co", "--exclude-standard", "*.md", ":!:fixtures/**"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .trim()
  .split("\n")
  .filter(Boolean);

const failures = [];
for (const file of files) {
  const lines = readFileSync(resolve(root, file), "utf8").split("\n");
  lines.forEach((line, index) => {
    if (denialContext.test(line)) return;
    for (const pattern of prohibited) {
      if (pattern.test(line)) {
        failures.push(`${file}:${index + 1}: possible affiliation claim: ${line.trim()}`);
        break;
      }
    }
  });
}

if (failures.length > 0) {
  throw new Error(`Affiliation scan failed (§1.5 trademark rule):\n${failures.join("\n")}`);
}

console.log(`Affiliation scan passed (${files.length} Markdown files)`);
