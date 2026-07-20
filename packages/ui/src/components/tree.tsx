/**
 * ARIA tree (§4.3/§4.4, LOA-50): virtualized file-explorer tree with
 * hierarchical semantics (level/expanded/selected), ⌘-click multiselect,
 * ⇧-range selection, shared drop indicators, and an inline-rename slot.
 *
 * The container is the tab stop (aria-activedescendant roving); visible
 * nodes are flattened and windowed through VirtualList, so focus survives
 * rows unmounting during scroll.
 */

import { ChevronRight } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import { ListRow } from "./rows";
import { VirtualList } from "./virtual-list";
import "./list.css";

export interface TreeNode {
  id: string;
  label: string;
  icon?: ReactNode;
  children?: TreeNode[];
}

export interface FlatNode {
  node: TreeNode;
  level: number;
  parentId: string | null;
  setSize: number;
  posInSet: number;
}

/** Flattens the expanded portion of the tree, depth first. */
export function flattenTree(nodes: TreeNode[], expanded: ReadonlySet<string>): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (children: TreeNode[], level: number, parentId: string | null): void => {
    children.forEach((node, index) => {
      out.push({ node, level, parentId, setSize: children.length, posInSet: index + 1 });
      if (node.children && expanded.has(node.id)) {
        walk(node.children, level + 1, node.id);
      }
    });
  };
  walk(nodes, 1, null);
  return out;
}

export interface TreeDropIndicator {
  id: string;
  position: "above" | "below" | "into";
}

export interface TreeProps {
  nodes: TreeNode[];
  /** Accessible name of the tree. */
  label: string;
  expanded?: Set<string>;
  onExpandedChange?: (expanded: Set<string>) => void;
  selected?: Set<string>;
  onSelectedChange?: (selected: Set<string>) => void;
  /** Open a node (Enter / double-click). */
  onOpen?: (id: string) => void;
  /** Node currently in inline rename; renders an input in its row. */
  renamingId?: string | null;
  onRenameCommit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
  /** Drag-drop indicator target (§4.4: one style everywhere). */
  dropIndicator?: TreeDropIndicator | null;
  rowHeight?: number;
  height?: number | string;
  className?: string;
}

export function Tree({
  nodes,
  label,
  expanded: expandedProp,
  onExpandedChange,
  selected: selectedProp,
  onSelectedChange,
  onOpen,
  renamingId,
  onRenameCommit,
  onRenameCancel,
  dropIndicator,
  rowHeight = 28,
  height = "100%",
  className,
}: TreeProps): ReactNode {
  const [expandedState, setExpandedState] = useState<Set<string>>(() => new Set());
  const [selectedState, setSelectedState] = useState<Set<string>>(() => new Set());
  const [activeIndex, setActiveIndex] = useState(0);
  const [anchorId, setAnchorId] = useState<string | null>(null);

  const expanded = expandedProp ?? expandedState;
  const selected = selectedProp ?? selectedState;
  const setExpanded = useCallback(
    (next: Set<string>): void => {
      setExpandedState(next);
      onExpandedChange?.(next);
    },
    [onExpandedChange],
  );
  const setSelected = useCallback(
    (next: Set<string>): void => {
      setSelectedState(next);
      onSelectedChange?.(next);
    },
    [onSelectedChange],
  );

  const flat = useMemo(() => flattenTree(nodes, expanded), [nodes, expanded]);

  const selectRange = (fromId: string, toIndex: number): void => {
    const fromIndex = flat.findIndex((entry) => entry.node.id === fromId);
    if (fromIndex < 0) return;
    const [start, end] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
    setSelected(new Set(flat.slice(start, end + 1).map((entry) => entry.node.id)));
  };

  const onRowClick = (index: number, event: MouseEvent): void => {
    const entry = flat[index];
    if (!entry) return;
    const id = entry.node.id;
    setActiveIndex(index);
    if (event.shiftKey && anchorId) {
      // §4.4: ⇧-range from the selection anchor.
      selectRange(anchorId, index);
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      // §4.4: ⌘-click toggles membership.
      const next = new Set(selected);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      setSelected(next);
      setAnchorId(id);
      return;
    }
    setSelected(new Set([id]));
    setAnchorId(id);
    // Plain click on a folder also toggles it (caret affordance).
    if (entry.node.children?.length) {
      toggleExpanded(id);
    }
  };

  const toggleExpanded = (id: string): void => {
    const next = new Set(expanded);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setExpanded(next);
  };

  /** Tree-specific keys; the rest (↑↓/Home/End/Enter) fall through. */
  const onTreeKeys = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    const entry = flat[activeIndex];
    if (!entry) return false;
    const { node } = entry;
    const isFolder = Boolean(node.children?.length);
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (isFolder && !expanded.has(node.id)) {
        toggleExpanded(node.id);
      } else if (isFolder) {
        setActiveIndex(Math.min(flat.length - 1, activeIndex + 1));
      }
      return true;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (isFolder && expanded.has(node.id)) {
        toggleExpanded(node.id);
      } else if (entry.parentId) {
        const parentIndex = flat.findIndex((candidate) => candidate.node.id === entry.parentId);
        if (parentIndex >= 0) setActiveIndex(parentIndex);
      }
      return true;
    }
    if (event.key === " ") {
      event.preventDefault();
      const next = new Set(event.metaKey || event.ctrlKey ? selected : []);
      if (next.has(node.id)) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      setSelected(next);
      setAnchorId(node.id);
      return true;
    }
    return false;
  };

  return (
    <VirtualList
      count={flat.length}
      rowHeight={rowHeight}
      label={label}
      role="tree"
      activeIndex={activeIndex}
      onActiveIndexChange={setActiveIndex}
      onRowActivate={(index) => {
        const entry = flat[index];
        if (!entry) return;
        if (entry.node.children?.length) {
          toggleExpanded(entry.node.id);
        } else {
          onOpen?.(entry.node.id);
        }
      }}
      onKeyDownCapture={onTreeKeys}
      className={className}
      style={{ height }}
      containerProps={{ "aria-multiselectable": true }}
      renderRow={({ index, active, domId }) => {
        const entry = flat[index] as FlatNode;
        const { node, level, setSize, posInSet } = entry;
        const isFolder = Boolean(node.children?.length);
        const isExpanded = expanded.has(node.id);
        const renaming = renamingId === node.id;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard operation happens on the tree container (aria-activedescendant roving: arrows, Enter, Space) — treeitems are pointer targets only.
          <div
            id={domId}
            role="treeitem"
            tabIndex={-1}
            aria-level={level}
            aria-setsize={setSize}
            aria-posinset={posInSet}
            aria-expanded={isFolder ? isExpanded : undefined}
            aria-selected={selected.has(node.id)}
            aria-label={node.label}
            onClick={(event) => onRowClick(index, event)}
            onDoubleClick={() => (isFolder ? undefined : onOpen?.(node.id))}
          >
            <ListRow
              style={{
                paddingInlineStart: `calc(${level - 1} * var(--loam-space-16) + var(--loam-space-4))`,
              }}
              icon={
                <>
                  <span
                    className="loam-tree-row__caret"
                    data-expanded={isFolder && isExpanded ? "" : undefined}
                    data-leaf={isFolder ? undefined : ""}
                  >
                    <ChevronRight size={14} strokeWidth={1.5} />
                  </span>
                  {node.icon}
                </>
              }
              selected={selected.has(node.id)}
              active={active}
              drop={dropIndicator?.id === node.id ? dropIndicator.position : undefined}
              renameProps={
                renaming
                  ? {
                      defaultValue: node.label,
                      "aria-label": `Rename ${node.label}`,
                      autoFocus: true,
                      onKeyDown: (event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") {
                          onRenameCommit?.(node.id, (event.target as HTMLInputElement).value);
                        } else if (event.key === "Escape") {
                          onRenameCancel?.();
                        }
                      },
                    }
                  : undefined
              }
            >
              {node.label}
            </ListRow>
          </div>
        );
      }}
    />
  );
}
