import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// LOA-49 AC3: the macOS checklist must cover the required scenarios, and the
// macOS automation gap must be documented explicitly.
const required = [
  "Boot",
  "Focus",
  "Close",
  "Folder picker",
  "Duplicate open",
  "Titlebar overlay",
  "Menus",
  "CLI open",
  "Drag-drop",
  "Deep link",
];

const checklist = readFileSync(
  resolve(import.meta.dirname, "../docs/native-smoke-checklist.md"),
  "utf8",
);

const missing = required.filter((item) => !checklist.includes(`**${item}**`));
if (missing.length > 0) {
  throw new Error(`native-smoke-checklist.md is missing items: ${missing.join(", ")}`);
}
if (!/no WKWebView WebDriver support/i.test(checklist)) {
  throw new Error("native-smoke-checklist.md must document the macOS automation gap");
}
if (!/Loam\.app/.test(checklist)) {
  throw new Error("native-smoke-checklist.md must direct testers to the bundled app");
}
console.log(`Native checklist check passed (${required.length} required scenarios present)`);
