/**
 * CM6 theme + Markdown highlight style (LOA-68, §4.2/§4.3). Every value is
 * a §4.2 token, so the editor follows the app theme with no JS work: the
 * theme extension is static and `data-theme` on <html> does the switching.
 * Only the light/dark class flag lives in a compartment (CM6 needs it for
 * its own internal defaults).
 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** Structural theme: type scale, measure, selection, cursor, gutters. */
export const loamEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--loam-text-primary)",
    backgroundColor: "var(--loam-bg-app)",
    fontSize: "var(--loam-type-editor-size)",
  },
  ".cm-scroller": {
    fontFamily: "var(--loam-font-mono)",
    lineHeight: "var(--loam-type-editor-line)",
    overflow: "auto",
    // The scroller is a flex row of gutters + content; centering it (rather
    // than the content alone) keeps the fold gutter beside the text.
    justifyContent: "center",
  },
  ".cm-content": {
    // §4.2 readable line length; the setting toggles the class in LOA-86.
    maxWidth: "var(--loam-editor-measure)",
    padding: "var(--loam-space-24) var(--loam-space-16)",
    caretColor: "var(--loam-accent)",
  },
  "&.cm-editor.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--loam-accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--loam-bg-selected)",
  },
  ".cm-activeLine": { backgroundColor: "var(--loam-bg-hover)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--loam-text-tertiary)",
    border: "none",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-selectionMatch": { backgroundColor: "var(--loam-bg-active)" },
  // LOA-85: the fold column always reserves its width, so revealing a
  // chevron on hover never reflows the text.
  ".cm-foldGutter .cm-gutterElement": { width: "1rem", padding: "0" },
  ".loam-fold-marker": {
    all: "unset",
    display: "block",
    width: "100%",
    textAlign: "center",
    cursor: "pointer",
    color: "var(--loam-text-tertiary)",
    opacity: "0",
    transition: "opacity var(--dur-fast) var(--loam-ease)",
  },
  // Visible on hover, on keyboard focus, and always while folded — a folded
  // section must stay discoverable without a pointer.
  "&:hover .loam-fold-marker, .loam-fold-marker:focus-visible, .loam-fold-marker-closed": {
    opacity: "1",
  },
  ".loam-fold-marker:hover": { color: "var(--loam-text-primary)" },
  // §4.6 shared focus ring.
  ".loam-fold-marker:focus-visible": {
    outline: "1.5px solid var(--loam-accent)",
    outlineOffset: "-1px",
    borderRadius: "var(--loam-radius-input)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--loam-bg-active)",
    border: "1px solid var(--loam-border)",
    borderRadius: "var(--loam-radius-input)",
    color: "var(--loam-text-secondary)",
    padding: "0 var(--loam-space-4)",
    margin: "0 var(--loam-space-2)",
  },
  // LOA-102 Live Preview: §4.2 editor heading roles. Sizes are em-relative
  // so they scale with the editor's own type size.
  ".cm-loam-h1": {
    fontSize: "var(--loam-type-h1-size)",
    fontWeight: "var(--loam-type-h1-weight)",
    lineHeight: "1.3",
  },
  ".cm-loam-h2": {
    fontSize: "var(--loam-type-h2-size)",
    fontWeight: "var(--loam-type-h2-weight)",
    lineHeight: "1.35",
  },
  ".cm-loam-h3": {
    fontSize: "var(--loam-type-h3-size)",
    fontWeight: "var(--loam-type-h3-weight)",
  },
  ".cm-loam-h4": {
    fontSize: "var(--loam-type-h4-size)",
    fontWeight: "var(--loam-type-h4-weight)",
  },
  // H5 and H6 share H4's metrics and step down in color instead (§4.2).
  ".cm-loam-h5": {
    fontSize: "var(--loam-type-h4-size)",
    fontWeight: "var(--loam-type-h4-weight)",
    color: "var(--loam-text-secondary)",
  },
  ".cm-loam-h6": {
    fontSize: "var(--loam-type-h4-size)",
    fontWeight: "var(--loam-type-h4-weight)",
    color: "var(--loam-text-tertiary)",
  },
  // LOA-107 structure: list markers keep their column and just change ink.
  ".cm-loam-list-mark": { color: "var(--loam-accent-text)" },
  // The checkbox replaces `[ ]`/`[x]`; sized to the text so lines keep their
  // rhythm, and it carries its own state for assistive tech.
  ".cm-loam-task": {
    verticalAlign: "middle",
    margin: "0 0.35em 0 0",
    width: "0.95em",
    height: "0.95em",
    accentColor: "var(--loam-accent)",
    cursor: "pointer",
  },
  ".cm-loam-task:focus-visible": {
    outline: "1.5px solid var(--loam-accent)",
    outlineOffset: "1px",
  },
  // Quotes read by border + indent + color, never color alone (§4.6).
  ".cm-loam-quote": {
    borderInlineStart: "2px solid var(--loam-border-strong)",
    paddingInlineStart: "var(--loam-space-12)",
    color: "var(--loam-text-secondary)",
  },
  ".cm-loam-quote-2": { marginInlineStart: "var(--loam-space-12)" },
  ".cm-loam-quote-3": { marginInlineStart: "var(--loam-space-24)" },
  // LOA-110 fenced blocks: 13.5 px mono on a raised surface, with the fence
  // rounded at its ends so the block reads as one object.
  ".cm-loam-fence": {
    backgroundColor: "var(--loam-bg-raised)",
    fontSize: "var(--loam-type-code-size)",
    paddingInline: "var(--loam-space-12)",
  },
  ".cm-loam-fence-open": {
    borderStartStartRadius: "var(--loam-radius-input)",
    borderStartEndRadius: "var(--loam-radius-input)",
    paddingBlockStart: "var(--loam-space-4)",
  },
  ".cm-loam-fence-close": {
    borderEndStartRadius: "var(--loam-radius-input)",
    borderEndEndRadius: "var(--loam-radius-input)",
    paddingBlockEnd: "var(--loam-space-4)",
  },
  ".cm-loam-fence-controls": {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--loam-space-8)",
    userSelect: "none",
  },
  ".cm-loam-fence-lang": {
    color: "var(--loam-text-tertiary)",
    fontSize: "var(--loam-type-secondary-size)",
    textTransform: "lowercase",
  },
  // The copy action stays out of the way until the block is hovered or the
  // button itself is focused — the same rule the fold chevrons follow.
  ".cm-loam-fence-copy": {
    all: "unset",
    cursor: "pointer",
    color: "var(--loam-text-secondary)",
    fontSize: "var(--loam-type-secondary-size)",
    padding: "0 var(--loam-space-4)",
    borderRadius: "var(--loam-radius-input)",
    opacity: "0",
    transition: "opacity var(--dur-fast) var(--loam-ease)",
  },
  ".cm-loam-fence:hover .cm-loam-fence-copy, .cm-loam-fence-copy:focus-visible": { opacity: "1" },
  ".cm-loam-fence-copy:hover": { color: "var(--loam-text-primary)" },
  ".cm-loam-fence-copy:focus-visible": {
    outline: "1.5px solid var(--loam-accent)",
    outlineOffset: "1px",
  },
  ".cm-loam-fence-copy[data-copied]": { color: "var(--loam-success)", opacity: "1" },
  // LOA-114 property table: a quiet block at the top of the note, keys in
  // secondary ink so values lead.
  ".cm-loam-props": {
    width: "100%",
    borderCollapse: "collapse",
    margin: "0 0 var(--loam-space-12)",
    fontSize: "var(--loam-type-base-size)",
    fontFamily: "var(--loam-font-ui)",
    borderBlockEnd: "1px solid var(--loam-border)",
  },
  ".cm-loam-props-caption": {
    // Available to assistive tech, out of the way visually.
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
  ".cm-loam-props th": {
    textAlign: "start",
    fontWeight: "var(--loam-type-base-weight)",
    color: "var(--loam-text-secondary)",
    padding: "var(--loam-space-4) var(--loam-space-12) var(--loam-space-4) 0",
    verticalAlign: "baseline",
    width: "12rem",
  },
  ".cm-loam-props td": {
    padding: "var(--loam-space-4) 0",
    color: "var(--loam-text-primary)",
    verticalAlign: "baseline",
  },
  ".cm-loam-props-empty": { color: "var(--loam-text-tertiary)" },
  ".cm-loam-prop-chip": {
    display: "inline-block",
    backgroundColor: "var(--loam-bg-active)",
    borderRadius: "var(--loam-radius-input)",
    padding: "0 var(--loam-space-6)",
    marginInlineEnd: "var(--loam-space-4)",
  },
  ".cm-loam-prop-chip-known": { color: "var(--loam-accent-text)" },
  ".cm-loam-props-error": {
    color: "var(--loam-warning)",
    fontFamily: "var(--loam-font-ui)",
    fontSize: "var(--loam-type-secondary-size)",
    padding: "var(--loam-space-4) 0",
  },
  // Inline code reads as a raised chip rather than just recolored text.
  ".cm-loam-code": {
    backgroundColor: "var(--loam-bg-active)",
    borderRadius: "var(--loam-radius-input)",
    padding: "0.05em 0.3em",
    fontSize: "var(--loam-type-code-size)",
  },
  ".cm-searchMatch": { backgroundColor: "var(--loam-highlight)" },
  ".cm-searchMatch.cm-searchMatch-selected": {
    outline: "1.5px solid var(--loam-accent)",
  },
  ".cm-placeholder": { color: "var(--loam-text-tertiary)" },
});

/** Markdown syntax colors — §4.2 tokens only. */
export const loamHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: "var(--loam-text-primary)", fontWeight: "650" },
  { tag: tags.heading2, color: "var(--loam-text-primary)", fontWeight: "650" },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: "600" },
  { tag: tags.strong, fontWeight: "650", color: "var(--loam-text-primary)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--loam-accent-text)" },
  { tag: tags.url, color: "var(--loam-accent-text)" },
  { tag: tags.monospace, color: "var(--loam-text-secondary)" },
  { tag: tags.quote, color: "var(--loam-text-secondary)", fontStyle: "italic" },
  { tag: tags.list, color: "var(--loam-text-secondary)" },
  // Formatting marks stay quiet in Source; Live Preview (E10) hides them.
  { tag: tags.processingInstruction, color: "var(--loam-text-tertiary)" },
  { tag: tags.meta, color: "var(--loam-text-tertiary)" },
  { tag: tags.contentSeparator, color: "var(--loam-border-strong)" },
  { tag: tags.keyword, color: "var(--loam-accent-text)" },
  { tag: tags.comment, color: "var(--loam-text-tertiary)", fontStyle: "italic" },
  { tag: tags.string, color: "var(--loam-success)" },
  { tag: tags.number, color: "var(--loam-warning)" },
  { tag: tags.invalid, color: "var(--loam-danger)" },
]);

/** The full appearance bundle (theme + highlighting). */
export function loamAppearance(): Extension {
  return [loamEditorTheme, syntaxHighlighting(loamHighlightStyle)];
}
