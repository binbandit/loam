/** Stories for tooltip & popover (LOA-37). Rendered per theme by the LOA-53 host. */

import { Bold, Italic, Link } from "lucide-react";
import { Button, IconButton } from "./button";
import { Popover } from "./popover";
import { Tooltip, TooltipProvider } from "./tooltip";

export default { title: "Primitives / Floating" };

export function Tooltips() {
  return (
    <TooltipProvider>
      <div style={{ display: "flex", gap: "var(--loam-space-8)" }}>
        <Tooltip content="Bold" shortcut="⌘B">
          <IconButton label="Bold">
            <Bold size={16} strokeWidth={1.5} />
          </IconButton>
        </Tooltip>
        <Tooltip content="Italic" shortcut="⌘I">
          <IconButton label="Italic">
            <Italic size={16} strokeWidth={1.5} />
          </IconButton>
        </Tooltip>
        <Tooltip content="Copy link">
          <IconButton label="Copy link">
            <Link size={16} strokeWidth={1.5} />
          </IconButton>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

export function PopoverStory() {
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button>Note info</Button>} />
      <Popover.Content side="bottom">
        <Popover.Title>Ideas.md</Popover.Title>
        <Popover.Description>Created yesterday · 412 words · 3 linked mentions</Popover.Description>
      </Popover.Content>
    </Popover.Root>
  );
}
