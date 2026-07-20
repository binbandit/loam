/** Stories for menus (LOA-37). Rendered per theme by the LOA-53 host. */

import { Copy, FilePlus, FolderOpen, Trash2 } from "lucide-react";
import { Button } from "./button";
import { ContextMenu, Menu } from "./menu";

export default { title: "Primitives / Menu" };

export function FileMenu() {
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button>File</Button>} />
      <Menu.Content>
        <Menu.Group>
          <Menu.GroupLabel>Vault</Menu.GroupLabel>
          <Menu.Item icon={<FilePlus size={16} strokeWidth={1.5} />} shortcut="⌘N">
            New note
          </Menu.Item>
          <Menu.Item icon={<Copy size={16} strokeWidth={1.5} />} shortcut="⌘D">
            Duplicate
          </Menu.Item>
        </Menu.Group>
        <Menu.Separator />
        <Menu.Submenu>
          <Menu.SubmenuTrigger icon={<FolderOpen size={16} strokeWidth={1.5} />}>
            Open recent
          </Menu.SubmenuTrigger>
          <Menu.Content>
            <Menu.Item>Ideas.md</Menu.Item>
            <Menu.Item>Daily note.md</Menu.Item>
            <Menu.Item>Reading list.md</Menu.Item>
          </Menu.Content>
        </Menu.Submenu>
        <Menu.Separator />
        <Menu.Item danger icon={<Trash2 size={16} strokeWidth={1.5} />} shortcut="⌘⌫">
          Move to trash
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}

export function RightClickMenu() {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        <div
          style={{
            display: "grid",
            placeItems: "center",
            width: 280,
            height: 120,
            border: "1px dashed var(--loam-border-strong)",
            borderRadius: "var(--loam-radius-popover)",
            color: "var(--loam-text-secondary)",
          }}
        >
          Right-click here
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Content>
        <ContextMenu.Item shortcut="⏎">Open</ContextMenu.Item>
        <ContextMenu.Item shortcut="⌘⏎">Open in new tab</ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item danger shortcut="⌘⌫">
          Move to trash
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
