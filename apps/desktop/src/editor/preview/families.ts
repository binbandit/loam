/**
 * Heading and inline-emphasis families (LOA-102, §3.3 syntax / §4.2 type).
 * The engine (LOA-95) decides *when* to decorate; these decide *what*.
 *
 * Every rule here is reversible by construction: marks are hidden with
 * replace decorations and text is styled with mark/line decorations, so the
 * document always holds the Markdown the user typed. When the cursor is on a
 * line, the engine reports it as revealed and these families leave it alone.
 */

import { Decoration } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import { BLOCK_FAMILIES } from "./blocks";
import { codeFamily } from "./code";
import type { FamilyContext, SyntaxFamily } from "./engine";

const hide = Decoration.replace({});

/** §4.2 editor heading roles; the theme maps each class to its tokens. */
const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "cm-loam-h1",
  ATXHeading2: "cm-loam-h2",
  ATXHeading3: "cm-loam-h3",
  ATXHeading4: "cm-loam-h4",
  ATXHeading5: "cm-loam-h5",
  ATXHeading6: "cm-loam-h6",
  SetextHeading1: "cm-loam-h1",
  SetextHeading2: "cm-loam-h2",
};

const HEADING_LINE = Object.fromEntries(
  Object.entries(HEADING_CLASS).map(([node, className]) => [
    node,
    Decoration.line({ class: className }),
  ]),
);

/**
 * `# ` opening marks are hidden together with the space that follows them,
 * so a rendered heading starts at its text rather than one column in.
 */
function atxMarkEnd(context: FamilyContext, node: SyntaxNodeRef): number {
  const line = context.state.doc.lineAt(node.from);
  let end = node.to;
  while (end < line.to && context.state.sliceDoc(end, end + 1) === " ") end += 1;
  return end;
}

export const headingFamily: SyntaxFamily = {
  name: "headings",
  nodes: [...Object.keys(HEADING_CLASS), "HeaderMark"],

  decorate(node, context) {
    const lineDecoration = HEADING_LINE[node.name];
    if (lineDecoration) {
      // Typography is applied even on the cursor's line: revealing shows the
      // `#` marks, it does not drop the heading's role.
      const line = context.state.doc.lineAt(node.from);
      context.add(line.from, line.from, lineDecoration);
      return;
    }

    // HeaderMark: the `#`s of an ATX heading, or a Setext underline.
    if (context.revealed(node.from, node.to)) return;
    const line = context.state.doc.lineAt(node.from);
    // A Setext underline is a line of its own; hiding it would leave a blank
    // row, so it stays visible and the theme quiets it down instead.
    if (line.from === node.from && line.to === node.to) return;
    const end = node.from === line.from ? atxMarkEnd(context, node) : node.to;
    context.add(node.from, end, hide);
  },
};

/** Delimiters that disappear once the cursor leaves their line. */
const INLINE_MARKS = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark"]);

/** Inline spans that carry their own §4.2 styling beyond syntax color. */
const INLINE_CLASS: Record<string, Decoration> = {
  InlineCode: Decoration.mark({ class: "cm-loam-code" }),
};

export const inlineFamily: SyntaxFamily = {
  name: "inline",
  nodes: ["EmphasisMark", "StrikethroughMark", "CodeMark", "InlineCode", "Escape"],

  decorate(node, context) {
    const styled = INLINE_CLASS[node.name];
    if (styled) {
      context.add(node.from, node.to, styled);
      return;
    }
    if (context.revealed(node.from, node.to)) return;

    if (INLINE_MARKS.has(node.name)) {
      // `CodeMark` is shared with fenced blocks, which the code family owns
      // (LOA-110) — only inline code's own backticks belong here.
      if (node.name === "CodeMark" && node.node.parent?.name !== "InlineCode") return;
      context.add(node.from, node.to, hide);
      return;
    }

    // `\*` is literal text, never emphasis (the parser already refused to
    // pair it). Rendering drops the backslash and keeps the character.
    if (node.name === "Escape") context.add(node.from, node.from + 1, hide);
  },
};

/** The M1 families, in application order. */
export const CORE_FAMILIES: readonly SyntaxFamily[] = [
  headingFamily,
  inlineFamily,
  ...BLOCK_FAMILIES,
  codeFamily,
];
