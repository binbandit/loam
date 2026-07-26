/** LOA-110: fenced code blocks with edit-mode highlighting. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../sessions";
import { CODE_LANGUAGES, copyText, fenceContent, fenceLanguage, languageFor } from "./code";
import { engineOf } from "./engine";

const FIXTURE_DIR = join(import.meta.dirname, "../../../../../fixtures/markdown/core");
function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.md`), "utf8");
}

let counter = 0;
function editor(doc: string) {
  const registry = new SessionRegistry();
  counter += 1;
  const session = registry.open(`code-${counter}.md`, doc, null);
  const view = new EditorView({ state: session.state });
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
  return view;
}

function widgets(view: EditorView): Array<{ from: number; widget: WidgetType }> {
  const engine = engineOf(view);
  if (!engine) throw new Error("engine not mounted");
  const found: Array<{ from: number; widget: WidgetType }> = [];
  engine.decorations.between(0, view.state.doc.length, (from, _to, value) => {
    const spec = value.spec as { widget?: WidgetType };
    if (spec.widget) found.push({ from, widget: spec.widget });
  });
  return found;
}

function controlsFor(view: EditorView): HTMLElement[] {
  return widgets(view)
    .map((entry) => entry.widget.toDOM(view) as HTMLElement)
    .filter((dom) => dom.classList.contains("cm-loam-fence-controls"));
}

function lineClasses(view: EditorView): Map<number, string> {
  const engine = engineOf(view);
  if (!engine) throw new Error("engine not mounted");
  const classes = new Map<number, string>();
  engine.decorations.between(0, view.state.doc.length, (from, to, value) => {
    const spec = value.spec as { class?: string };
    if (value.point && from === to && spec.class) {
      classes.set(view.state.doc.lineAt(from).number, spec.class);
    }
  });
  return classes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** AC1: a registered grammar is available and the source is untouched. */
describe("language registry", () => {
  it("resolves aliases to a lazily loaded grammar", async () => {
    expect(fenceLanguage("  js  extra words ")).toBe("js");
    expect(fenceLanguage("   ")).toBeNull();

    const js = languageFor("js");
    expect(js?.name).toBe("JavaScript");
    expect(languageFor("tsx")?.name).toBe("TypeScript");
    expect(languageFor("CSS")?.name).toBe("CSS");
    // Unknown grammars simply have no entry — never a throw (AC2).
    expect(languageFor("rust")).toBeNull();
    expect(languageFor("")).toBeNull();

    // The grammar itself arrives through a dynamic import.
    const support = await js?.load();
    expect(support?.language.name).toBe("javascript");
  });

  it("every registered language declares a loader", () => {
    for (const language of CODE_LANGUAGES) {
      expect(typeof language.load).toBe("function");
      expect(language.alias.length).toBeGreaterThan(0);
    }
  });

  it("highlights a supported fence without changing the document", async () => {
    const source = "```js\nconst answer = 42;\n```\n";
    const view = editor(source);
    const js = languageFor("js");
    await js?.load();
    // Give the parser a chance to attach the nested grammar.
    await new Promise((resolve) => setTimeout(resolve, 50));
    view.dispatch({ changes: { from: view.state.doc.length, insert: "" } });

    const names: string[] = [];
    syntaxTree(view.state).iterate({
      enter: (node) => {
        names.push(node.name);
      },
    });
    expect(names).toContain("FencedCode");
    expect(view.state.doc.toString()).toBe(source);
  });
});

/** AC2: an unknown language still gets a block and a label. */
describe("unknown languages", () => {
  it("labels the chip with whatever the fence asked for", () => {
    const view = editor("```rust\nfn main() {}\n```\n");
    const [controls] = controlsFor(view);
    expect(controls?.querySelector(".cm-loam-fence-lang")?.textContent).toBe("rust");
    expect(view.state.doc.toString()).toBe("```rust\nfn main() {}\n```\n");
  });

  it("a bare fence is labelled text", () => {
    const view = editor("```\nplain\n```\n");
    const [controls] = controlsFor(view);
    expect(controls?.querySelector(".cm-loam-fence-lang")?.textContent).toBe("text");
  });

  it("renders every fence in the E03 code-fences fixture", () => {
    const source = fixture("code-fences");
    const view = editor(source);
    const labels = controlsFor(view).map(
      (dom) => dom.querySelector(".cm-loam-fence-lang")?.textContent,
    );
    // rust, bare, and the tilde-fenced python block with trailing info words.
    expect(labels).toEqual(["rust", "text", "python"]);
    expect(view.state.doc.toString()).toBe(source);
  });
});

/** AC3: copy takes the code and nothing else. */
describe("copy action", () => {
  const source = "```js\nconst a = 1;\nconst b = 2;\n```\n";

  it("extracts the block contents without fences or info", () => {
    const view = editor(source);
    const fence = syntaxTree(view.state).topNode.firstChild;
    if (!fence) throw new Error("no fence parsed");
    expect(fenceContent(view.state, fence)).toBe("const a = 1;\nconst b = 2;");
  });

  it("writes exactly that text to the clipboard and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const button = document.createElement("button");
    await copyText("const a = 1;", button);
    expect(writeText).toHaveBeenCalledWith("const a = 1;");
    expect(button.textContent).toBe("Copied");
  });

  it("a denied clipboard is reported, not thrown", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error("denied")),
      },
    });
    const button = document.createElement("button");
    await expect(copyText("x", button)).resolves.toBe(false);
    expect(button.textContent).toBe("Copy failed");
  });

  it("the copy button is a labelled, keyboard-reachable button", () => {
    const view = editor(source);
    const [controls] = controlsFor(view);
    const copy = controls?.querySelector("button");
    expect(copy?.getAttribute("aria-label")).toBe("Copy js code");
    expect(copy?.getAttribute("tabindex")).toBeNull();
  });
});

/** AC4: fence markers come back while the cursor is on their line. */
describe("fence reveal", () => {
  const source = "```js\nconst a = 1;\n```\n\ntail\n";

  it("hides the fence markers and info by default", () => {
    const view = editor(source);
    const engine = engineOf(view);
    if (!engine) throw new Error("engine not mounted");
    const hidden: string[] = [];
    engine.decorations.between(0, view.state.doc.length, (from, to, value) => {
      const spec = value.spec as { class?: string; widget?: unknown };
      if (!spec.class && !spec.widget && from !== to) hidden.push(view.state.sliceDoc(from, to));
    });
    expect(hidden).toContain("```");
    expect(hidden).toContain("js");
  });

  it("reveals them on the cursor's line only", () => {
    const view = editor(source);
    view.dispatch({ selection: EditorSelection.cursor(2) });
    const engine = engineOf(view);
    if (!engine) throw new Error("engine not mounted");
    const revealedLine = view.state.doc.line(1);
    engine.decorations.between(revealedLine.from, revealedLine.to, (from, to, value) => {
      const spec = value.spec as { class?: string; widget?: unknown };
      // Nothing on the cursor's line is replaced any more.
      if (!spec.class && !spec.widget) expect(from).toBe(to);
    });
    expect(view.state.doc.toString()).toBe(source);
  });

  it("marks the block's first, middle, and last lines distinctly", () => {
    const view = editor("```\nalpha\nbeta\n```\n");
    const classes = lineClasses(view);
    expect(classes.get(1)).toContain("cm-loam-fence-open");
    expect(classes.get(2)).toBe("cm-loam-fence");
    expect(classes.get(4)).toContain("cm-loam-fence-close");
  });
});
