/** Stories for text inputs (LOA-33). Rendered per theme by the LOA-53 host. */

import { Input, SearchField, Textarea } from "./input";

export default { title: "Primitives / Input" };

const column = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--loam-space-12)",
  maxWidth: 320,
} as const;

export function Inputs() {
  return (
    <div style={column}>
      <Input placeholder="Note title" aria-label="Note title" />
      <Input defaultValue="Ideas.md" invalid aria-label="File name" />
      <Input placeholder="Disabled" aria-label="Disabled input" disabled />
    </div>
  );
}

export function Textareas() {
  return (
    <div style={column}>
      <Textarea placeholder="Describe the change" aria-label="Description" />
      <Textarea defaultValue="Too long" invalid aria-label="Invalid description" />
    </div>
  );
}

export function SearchFields() {
  return (
    <div style={column}>
      <SearchField placeholder="Search notes" aria-label="Search notes" shortcut="⌘K" />
      <SearchField placeholder="Search notes" aria-label="Search notes (disabled)" disabled />
    </div>
  );
}
