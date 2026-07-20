/** Stories for virtualized lists, rows, and tree (LOA-50). Rendered per theme by the LOA-53 host. */

import { FileText, Folder, Search } from "lucide-react";
import { useState } from "react";
import { ListRow, ResultRow } from "./rows";
import { Tree, type TreeNode } from "./tree";
import { VirtualList } from "./virtual-list";

export default { title: "Primitives / Lists" };

export function HundredKList() {
  const [active, setActive] = useState(0);
  return (
    <VirtualList
      count={100_000}
      rowHeight={28}
      label="All notes"
      role="listbox"
      activeIndex={active}
      onActiveIndexChange={setActive}
      style={{ height: 240, border: "1px solid var(--loam-border)", borderRadius: 8 }}
      renderRow={({ index, domId, active: isActive }) => (
        <div id={domId} role="option" tabIndex={-1} aria-selected={isActive}>
          <ListRow
            icon={<FileText size={16} strokeWidth={1.5} />}
            active={isActive}
            detail={index % 7 === 0 ? "today" : undefined}
          >
            Note {index.toLocaleString()}.md
          </ListRow>
        </div>
      )}
    />
  );
}

export function Rows() {
  return (
    <div style={{ display: "grid", gap: "var(--loam-space-8)", maxWidth: 380 }}>
      <ListRow icon={<FileText size={16} strokeWidth={1.5} />} detail={12}>
        Backlinks
      </ListRow>
      <ListRow icon={<FileText size={16} strokeWidth={1.5} />} selected shortcut="⌘1">
        Selected row
      </ListRow>
      <ListRow icon={<FileText size={16} strokeWidth={1.5} />} drop="below">
        Drop target (below)
      </ListRow>
      <ListRow
        icon={<FileText size={16} strokeWidth={1.5} />}
        renameProps={{ defaultValue: "Ideas.md", "aria-label": "Rename Ideas.md" }}
      />
      <ResultRow
        icon={<Search size={16} strokeWidth={1.5} />}
        title="Ideas.md"
        detail="Projects / Notes · matched in body"
        meta="⌘⏎"
        active
      />
      <ResultRow
        icon={<FileText size={16} strokeWidth={1.5} />}
        title="A very long result title that will truncate cleanly.md"
        detail="Archive / 2025"
        meta="⏎"
      />
    </div>
  );
}

const TREE: TreeNode[] = [
  {
    id: "projects",
    label: "Projects",
    icon: <Folder size={16} strokeWidth={1.5} />,
    children: [
      { id: "loam", label: "Loam.md", icon: <FileText size={16} strokeWidth={1.5} /> },
      { id: "garden", label: "Garden.md", icon: <FileText size={16} strokeWidth={1.5} /> },
      { id: "reading", label: "Reading list.md", icon: <FileText size={16} strokeWidth={1.5} /> },
    ],
  },
  {
    id: "archive",
    label: "Archive",
    icon: <Folder size={16} strokeWidth={1.5} />,
    children: [
      { id: "old", label: "2025 notes.md", icon: <FileText size={16} strokeWidth={1.5} /> },
    ],
  },
  { id: "daily", label: "Daily note.md", icon: <FileText size={16} strokeWidth={1.5} /> },
  { id: "ideas", label: "Ideas.md", icon: <FileText size={16} strokeWidth={1.5} /> },
];

export function FileTree() {
  const [expanded, setExpanded] = useState(new Set(["projects"]));
  const [selected, setSelected] = useState(new Set(["loam", "garden"]));
  return (
    <div style={{ maxWidth: 280 }}>
      <Tree
        nodes={TREE}
        label="Files"
        height={240}
        expanded={expanded}
        onExpandedChange={setExpanded}
        selected={selected}
        onSelectedChange={setSelected}
        dropIndicator={{ id: "daily", position: "below" }}
        renamingId="ideas"
      />
    </div>
  );
}
