/**
 * Fenced code blocks (LOA-110, §3.3). Fences render as a raised block with a
 * language chip and a copy action; the ``` markers come back when the cursor
 * is on their line, like every other mark.
 *
 * Languages load on demand (`LanguageDescription.load()` is a dynamic
 * import), so a note full of prose never pays for a grammar it does not use,
 * and typing is never blocked waiting for one. Shiki stays out of this
 * entirely — it belongs to the Reading view (E17), not the editor.
 */

import { LanguageDescription } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import type { SyntaxFamily } from "./engine";

const hide = Decoration.replace({});

/**
 * Grammars Loam can highlight in edit modes. Each `load` is a dynamic import
 * — the grammar becomes its own chunk and is fetched the first time a fence
 * asks for it.
 */
export const CODE_LANGUAGES: LanguageDescription[] = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "javascript", "jsx", "node"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts", "typescript", "tsx"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ jsx: true, typescript: true }),
      ),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["json"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  }),
  LanguageDescription.of({
    name: "CSS",
    alias: ["css"],
    load: () => import("@codemirror/lang-css").then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: "HTML",
    alias: ["html", "htm", "xml"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  }),
];

/** The language a fence asks for, or null for a bare ``` fence. */
export function fenceLanguage(info: string): string | null {
  const first = info.trim().split(/\s+/)[0];
  return first ? first : null;
}

/** The registered grammar for a fence's info string, if Loam has one. */
export function languageFor(info: string): LanguageDescription | null {
  const name = fenceLanguage(info);
  if (!name) return null;
  return LanguageDescription.matchLanguageName(CODE_LANGUAGES, name, true);
}

/** The block's exact contents — no fences, no info string (AC3). */
export function fenceContent(state: EditorState, fence: SyntaxNodeRef): string {
  const text = fence.node.getChild("CodeText");
  return text ? state.sliceDoc(text.from, text.to) : "";
}

/** Chip + copy button; both appear on hover or keyboard focus. */
class FenceControls extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly code: string,
  ) {
    super();
  }

  override eq(other: FenceControls): boolean {
    return other.label === this.label && other.code === this.code;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-loam-fence-controls";

    const chip = document.createElement("span");
    chip.className = "cm-loam-fence-lang";
    chip.textContent = this.label;
    wrap.appendChild(chip);

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "cm-loam-fence-copy";
    copy.textContent = "Copy";
    copy.setAttribute("aria-label", `Copy ${this.label} code`);
    copy.addEventListener("mousedown", (event) => event.preventDefault());
    copy.addEventListener("click", (event) => {
      event.preventDefault();
      void copyText(this.code, copy);
    });
    wrap.appendChild(copy);
    return wrap;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Copies `text`, reporting the outcome on the button itself. */
export async function copyText(text: string, button?: HTMLElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      button.textContent = "Copied";
      button.setAttribute("data-copied", "true");
    }
    return true;
  } catch {
    // A denied clipboard is not an editor error; the button just says so.
    if (button) button.textContent = "Copy failed";
    return false;
  }
}

const FENCE_LINE = Decoration.line({ class: "cm-loam-fence" });
const FENCE_OPEN = Decoration.line({ class: "cm-loam-fence cm-loam-fence-open" });
const FENCE_CLOSE = Decoration.line({ class: "cm-loam-fence cm-loam-fence-close" });

export const codeFamily: SyntaxFamily = {
  name: "code",
  nodes: ["FencedCode", "CodeMark", "CodeInfo"],

  decorate(node, context) {
    const state = context.state;

    if (node.name === "FencedCode") {
      const first = state.doc.lineAt(node.from).number;
      const last = state.doc.lineAt(node.to).number;
      for (let number = first; number <= last; number += 1) {
        const line = state.doc.line(number);
        const decoration =
          number === first ? FENCE_OPEN : number === last ? FENCE_CLOSE : FENCE_LINE;
        context.add(line.from, line.from, decoration);
      }

      // The chip names the language even when Loam cannot highlight it (AC2).
      const info = node.node.getChild("CodeInfo");
      const label = info ? (fenceLanguage(state.sliceDoc(info.from, info.to)) ?? "text") : "text";
      const opening = state.doc.line(first);
      context.add(
        opening.to,
        opening.to,
        Decoration.widget({
          side: 1,
          widget: new FenceControls(label, fenceContent(state, node)),
        }),
      );
      return;
    }

    // Fence markers and the info string hide until the cursor arrives (AC4).
    if (context.revealed(node.from, node.to)) return;
    if (node.name === "CodeMark" && node.node.parent?.name !== "FencedCode") return;
    context.add(node.from, node.to, hide);
  },
};
