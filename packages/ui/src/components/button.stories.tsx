/**
 * Stories for buttons (LOA-33). Hosted by the story runner added in LOA-53;
 * the host renders every story in both themes for visual regression.
 */

import { Copy, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "./button";

export default { title: "Primitives / Button" };

export function Variants() {
  return (
    <div style={{ display: "flex", gap: "var(--loam-space-8)" }}>
      <Button variant="primary">New note</Button>
      <Button>Cancel</Button>
      <Button variant="ghost">Show more</Button>
      <Button variant="danger">Delete note</Button>
    </div>
  );
}

export function States() {
  return (
    <div style={{ display: "flex", gap: "var(--loam-space-8)" }}>
      <Button variant="primary" disabled>
        Disabled
      </Button>
      <Button variant="primary" loading>
        Rename 143 links
      </Button>
      <Button loading>Saving</Button>
      <Button icon={<Plus size={16} strokeWidth={1.5} />}>New folder</Button>
      <Button variant="primary" shortcut="⌘⏎">
        Open
      </Button>
    </div>
  );
}

export function IconButtons() {
  return (
    <div style={{ display: "flex", gap: "var(--loam-space-8)" }}>
      <IconButton label="Copy link">
        <Copy size={16} strokeWidth={1.5} />
      </IconButton>
      <IconButton label="Move to trash">
        <Trash2 size={16} strokeWidth={1.5} />
      </IconButton>
      <IconButton label="New note" disabled>
        <Plus size={16} strokeWidth={1.5} />
      </IconButton>
    </div>
  );
}
