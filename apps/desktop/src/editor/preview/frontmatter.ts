/**
 * YAML frontmatter as a read-only property table (LOA-114, §3.7).
 *
 * Two halves:
 *   - a Lezer block parser, so `---` at the top of a note is a real
 *     `Frontmatter` node the engine can route on (the Markdown dialect knows
 *     about frontmatter; §3.3 lists it as part of the format);
 *   - a deliberately small YAML reader. It handles what notes actually carry
 *     — scalars, flow lists, block lists — and refuses anything it cannot
 *     read rather than guessing. A refusal shows the banner and leaves the
 *     raw YAML on screen and in the file, exactly as loam-core reports it.
 *
 * The full typed property editor is M2 (E14); this is read-only.
 */

import { syntaxTree } from "@codemirror/language";
import { type EditorState, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { BlockContext, Line, MarkdownConfig } from "@lezer/markdown";
import { revealedSpans, type SyntaxFamily } from "./engine";

const DELIMITER = /^---\s*$/;

/**
 * `---` on the first line, closed by another `---`. An unclosed delimiter is
 * not frontmatter at all (loam-core reports `rawFrontmatter: null` for it),
 * so the parser leaves those lines to ordinary Markdown.
 */
export const frontmatterParser: MarkdownConfig = {
  defineNodes: [{ name: "Frontmatter", block: true }, { name: "FrontmatterMark" }],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx: BlockContext, line: Line) {
        if (cx.lineStart !== 0 || !DELIMITER.test(line.text)) return false;
        const start = cx.lineStart;
        const openEnd = start + line.text.length;
        while (cx.nextLine()) {
          if (!DELIMITER.test(line.text)) continue;
          const closeStart = cx.lineStart;
          const end = closeStart + line.text.length;
          cx.addElement(
            cx.elt("Frontmatter", start, end, [
              cx.elt("FrontmatterMark", start, openEnd),
              cx.elt("FrontmatterMark", closeStart, end),
            ]),
          );
          cx.nextLine();
          return true;
        }
        return false;
      },
    },
  ],
};

export interface Property {
  key: string;
  /** Scalar rendering, or the items of a list — order preserved. */
  value: string | string[];
}

export interface Frontmatter {
  properties: Property[];
}

const KEY_LINE = /^([A-Za-z0-9_][\w .-]*):\s?(.*)$/;
const LIST_ITEM = /^\s*-\s+(.*)$/;

/** Strips one layer of matching quotes; YAML scalars are plain text here. */
function scalar(raw: string): string {
  const text = raw.trim();
  const quoted = /^(["'])(.*)\1$/.exec(text);
  return quoted?.[2] ?? text;
}

/** `[a, "b c"]` → items, or null when the brackets do not balance. */
function flowList(raw: string): string[] | null {
  const text = raw.trim();
  if (!text.startsWith("[")) return null;
  if (!text.endsWith("]")) return null;
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  if (inner.includes("[") || inner.includes("]")) return null;
  return inner.split(",").map(scalar);
}

/**
 * Reads the subset of YAML notes actually use. Returns null when a line is
 * not confidently readable — the caller then shows the banner rather than a
 * half-parsed table.
 */
export function parseFrontmatter(yaml: string): Frontmatter | null {
  const properties: Property[] = [];
  const lines = yaml.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const match = KEY_LINE.exec(line);
    if (!match) return null;
    const [, key = "", rest = ""] = match;

    if (rest.trim() === "") {
      // Either an empty value or a block list on the following lines.
      const items: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? "";
        if (next.trim() === "") break;
        const item = LIST_ITEM.exec(next);
        if (!item) break;
        items.push(scalar(item[1] ?? ""));
        index += 1;
      }
      properties.push({ key, value: items.length > 0 ? items : "" });
      continue;
    }

    const flow = flowList(rest);
    if (flow) {
      properties.push({ key, value: flow });
      continue;
    }
    // An unbalanced bracket or a second `key:` inside the value is exactly
    // what YAML rejects — do not invent a reading for it.
    if (rest.includes("[") || rest.includes("]")) return null;
    if (/\S:\s/.test(rest)) return null;
    properties.push({ key, value: scalar(rest) });
  }

  return { properties };
}

/** Multi-value keys render as chips; §3.7 calls out tags and aliases. */
const LIST_KEYS = new Set(["tags", "aliases"]);

class PropertyTable extends WidgetType {
  constructor(private readonly frontmatter: Frontmatter) {
    super();
  }

  override eq(other: PropertyTable): boolean {
    return JSON.stringify(other.frontmatter) === JSON.stringify(this.frontmatter);
  }

  override toDOM(): HTMLElement {
    const table = document.createElement("table");
    table.className = "cm-loam-props";
    // AC5: a real table, so a screen reader reads "key, value" pairs.
    const caption = document.createElement("caption");
    caption.textContent = "Note properties";
    caption.className = "cm-loam-props-caption";
    table.appendChild(caption);

    const body = document.createElement("tbody");
    for (const property of this.frontmatter.properties) {
      const row = document.createElement("tr");
      const key = document.createElement("th");
      key.scope = "row";
      key.textContent = property.key;
      row.appendChild(key);

      const cell = document.createElement("td");
      if (Array.isArray(property.value)) {
        if (property.value.length === 0) cell.classList.add("cm-loam-props-empty");
        for (const item of property.value) {
          const chip = document.createElement("span");
          chip.className = LIST_KEYS.has(property.key)
            ? "cm-loam-prop-chip cm-loam-prop-chip-known"
            : "cm-loam-prop-chip";
          chip.textContent = item;
          cell.appendChild(chip);
        }
      } else if (property.value === "") {
        cell.textContent = "—";
        cell.classList.add("cm-loam-props-empty");
      } else {
        cell.textContent = property.value;
      }
      row.appendChild(cell);
      body.appendChild(row);
    }
    table.appendChild(body);
    return table;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** The §3.7 wording, shown verbatim when the YAML cannot be read. */
export const MALFORMED_NOTICE = "Frontmatter could not be parsed";

class MalformedBanner extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const banner = document.createElement("div");
    banner.className = "cm-loam-props-error";
    banner.setAttribute("role", "status");
    banner.textContent = MALFORMED_NOTICE;
    return banner;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Block decorations may not come from a view plugin, so the table lives in
 * its own state field. It is cheap: unless the note opens with `---` the
 * whole thing is one comparison.
 */
function build(state: EditorState): DecorationSet {
  const first = state.doc.lineAt(0);
  if (!DELIMITER.test(first.text)) return Decoration.none;

  const node = syntaxTree(state).topNode.firstChild;
  if (node?.name !== "Frontmatter") return Decoration.none;

  // Editing the block shows the YAML being edited.
  const revealed = revealedSpans(state).some(
    (span) => node.from <= span.to && node.to >= span.from,
  );
  if (revealed) return Decoration.none;

  const lastLine = state.doc.lineAt(node.to);
  const inner = state.sliceDoc(first.to + 1, lastLine.from).replace(/\n$/, "");
  const parsed = parseFrontmatter(inner);

  if (!parsed) {
    // AC3: the banner sits above untouched raw YAML.
    return Decoration.set([
      Decoration.widget({ widget: new MalformedBanner(), side: -1, block: true }).range(first.from),
    ]);
  }
  return Decoration.set([
    Decoration.replace({ widget: new PropertyTable(parsed), block: true }).range(
      node.from,
      node.to,
    ),
  ]);
}

export const frontmatterField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection) return value;
    return build(transaction.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * A family with no Lezer routes: everything it draws is a block, which the
 * field above owns. Registering it here keeps frontmatter a flag like every
 * other syntax family, on and off with the rest.
 */
export const frontmatterFamily: SyntaxFamily = {
  name: "frontmatter",
  nodes: [],
  decorate: () => {},
  extension: frontmatterField,
};
