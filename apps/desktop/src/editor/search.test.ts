/** LOA-74: find/replace over the CM6 search extension. */

import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  applyQuery,
  countMatches,
  findNextMatch,
  findPreviousMatch,
  regexError,
  replaceCurrent,
  replaceEvery,
} from "./search";
import { SessionRegistry } from "./sessions";

const DOC = "alpha beta\nAlpha gamma\nalphabet\nbeta\n";

function editor(doc = DOC) {
  const registry = new SessionRegistry();
  const session = registry.open("note.md", doc, null);
  const view = new EditorView({ state: session.state });
  return { registry, view };
}

describe("matching modes", () => {
  it("literal search is case-insensitive by default and counts every match", () => {
    const { view } = editor();
    expect(applyQuery(view, { search: "alpha" })).toBeNull();
    // alpha, Alpha, alphabet
    expect(countMatches(view.state).total).toBe(3);
  });

  it("case-sensitive narrows the set", () => {
    const { view } = editor();
    applyQuery(view, { search: "Alpha", caseSensitive: true });
    expect(countMatches(view.state).total).toBe(1);
  });

  it("whole-word excludes substrings", () => {
    const { view } = editor();
    applyQuery(view, { search: "alpha", wholeWord: true });
    // "alphabet" no longer counts.
    expect(countMatches(view.state).total).toBe(2);
  });

  it("regex matches patterns", () => {
    const { view } = editor();
    applyQuery(view, { search: "^beta$", regexp: true });
    expect(countMatches(view.state).total).toBe(1);
  });
});

/** AC2: the count follows the document as it changes. */
describe("live count", () => {
  it("recounts after an edit", () => {
    const { view } = editor();
    applyQuery(view, { search: "beta" });
    expect(countMatches(view.state).total).toBe(2);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "beta beta\n" } });
    expect(countMatches(view.state).total).toBe(4);
  });

  it("reports the current match position as the selection moves", () => {
    const { view } = editor();
    applyQuery(view, { search: "alpha" });
    view.dispatch({ selection: EditorSelection.cursor(0) });
    // The first ⏎ selects the match under the cursor; the next advances.
    findNextMatch(view);
    expect(countMatches(view.state).current).toBe(1);
    findNextMatch(view);
    expect(countMatches(view.state).current).toBe(2);
    findPreviousMatch(view);
    expect(countMatches(view.state).current).toBe(1);
  });
});

/** AC3: invalid regex reports without touching the document. */
describe("invalid regex", () => {
  it("is rejected before any dispatch", () => {
    const { view } = editor();
    const before = view.state.doc.toString();
    const error = applyQuery(view, { search: "alpha(", regexp: true });
    expect(error).toBeTruthy();
    expect(view.state.doc.toString()).toBe(before);
    expect(regexError("alpha(", true)).toBeTruthy();
    expect(regexError("alpha(", false)).toBeNull();
    expect(regexError("al.*pha", true)).toBeNull();
  });
});

/** AC4: replace-all is a single undoable transaction. */
describe("replace", () => {
  it("replaces one match, leaving the rest", () => {
    const { view } = editor();
    view.dispatch({ selection: EditorSelection.cursor(0) });
    applyQuery(view, { search: "beta", replace: "BETA" });
    findNextMatch(view);
    replaceCurrent(view);
    const text = view.state.doc.toString();
    expect(text).toContain("BETA");
    expect(text.match(/beta/g)?.length).toBe(1);
  });

  it("replace-all is undone by a single undo", () => {
    const { view } = editor();
    applyQuery(view, { search: "alpha", replace: "omega" });
    replaceEvery(view);
    const replaced = view.state.doc.toString();
    expect(replaced).not.toMatch(/alpha/i);
    expect(replaced.match(/omega/gi)?.length).toBe(3);
    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("regex replace supports capture groups", () => {
    const { view } = editor("2026-07-25\n");
    applyQuery(view, {
      search: "(\\d{4})-(\\d{2})-(\\d{2})",
      replace: "$3/$2/$1",
      regexp: true,
    });
    replaceEvery(view);
    expect(view.state.doc.toString()).toBe("25/07/2026\n");
  });
});
