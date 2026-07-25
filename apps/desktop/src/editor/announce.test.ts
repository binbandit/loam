/** LOA-90: §4.6 editor announcements and the §5.9 bench fixture. */

import { foldCode, unfoldAll } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { describeMatches, describeSelection } from "./announce";
import { benchDocument } from "./bench";
import { selectNext } from "./folding";
import { SessionRegistry } from "./sessions";

let counter = 0;
function editor(doc: string) {
  const registry = new SessionRegistry();
  counter += 1;
  const session = registry.open(`announce-${counter}.md`, doc, null);
  return new EditorView({ state: session.state });
}

/** Announcements are dispatched from a microtask, never during an update. */
async function announced(view: EditorView): Promise<string> {
  await Promise.resolve();
  await Promise.resolve();
  return view.dom.querySelector(".cm-announced")?.textContent ?? "";
}

describe("announcement text", () => {
  it("counts selections and matches in words, not symbols", () => {
    expect(describeSelection(1)).toBe("1 selection");
    expect(describeSelection(3)).toBe("3 selections");
    expect(describeMatches(0, 0)).toBe("No results");
    expect(describeMatches(3, 12)).toBe("Match 3 of 12");
  });
});

/** AC3: the live region carries what only the screen shows otherwise. */
describe("live region", () => {
  it("exists as a polite region on every editor", () => {
    const view = editor("hello");
    const region = view.dom.querySelector(".cm-announced");
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });

  it("announces the selection count when multicursor changes it", async () => {
    const view = editor("cat dog cat dog cat");
    view.dispatch({ selection: EditorSelection.cursor(1) });
    selectNext(view);
    selectNext(view);
    expect(await announced(view)).toContain("2 selections");
    selectNext(view);
    expect(await announced(view)).toContain("3 selections");
  });

  it("announces folding and unfolding", async () => {
    const view = editor("# Title\nbody one\nbody two");
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(foldCode(view)).toBe(true);
    expect(await announced(view)).toContain("Section folded");
    unfoldAll(view);
    expect(await announced(view)).toContain("Section unfolded");
  });

  it("stays quiet for ordinary cursor movement", async () => {
    const view = editor("one two three");
    view.dispatch({ selection: EditorSelection.cursor(4) });
    expect(await announced(view)).toBe("");
  });
});

/** AC1/AC5: the benchmark fixture is deterministic and the right size. */
describe("bench document", () => {
  it("is a ~10k-word Markdown note with headings and lists", () => {
    const doc = benchDocument();
    const words = doc.split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(10_000);
    expect(words).toBeLessThan(10_600);
    expect(doc).toContain("## Section 1");
    expect(doc.split("\n").some((line) => line.startsWith("- "))).toBe(true);
    // Deterministic: the gate compares runs, so the input can never drift.
    expect(benchDocument()).toBe(doc);
  });
});
