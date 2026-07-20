/**
 * The §3.1 file tree (LOA-72): E07 virtualized ARIA Tree bound to the E06
 * commands through the files store. Context menu + keyboard paths for every
 * action; renames inline; trash always means the OS trash.
 */

import type { TreeEntryDto, VaultInfo } from "@loam-app/ipc-client";
import { ContextMenu, Segment, SegmentedControl, Tree, type TreeNode } from "@loam-app/ui";
import { FileText, Folder } from "lucide-react";
import { useEffect, useMemo } from "react";
import {
  type FilesStore,
  selectEntries,
  selectSort,
  selectTreeError,
  type TreeSort,
} from "../stores/files";
import "./shell.css";

/** Builds the E07 TreeNode hierarchy from the flat sorted enumeration. */
export function buildTree(entries: TreeEntryDto[], sort: TreeSort): TreeNode[] {
  const byParent = new Map<string, TreeEntryDto[]>();
  for (const entry of entries) {
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    const siblings = byParent.get(parent) ?? [];
    siblings.push(entry);
    byParent.set(parent, siblings);
  }
  const toNodes = (parent: string): TreeNode[] => {
    const children = byParent.get(parent) ?? [];
    const sorted = [...children].sort((a, b) => {
      // Folders first in both modes (§3.1).
      const aFolder = a.kind === "folder" ? 0 : 1;
      const bFolder = b.kind === "folder" ? 0 : 1;
      if (aFolder !== bFolder) return aFolder - bFolder;
      if (sort === "modified") {
        return (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0);
      }
      return a.name.localeCompare(b.name);
    });
    return sorted.map((entry) => ({
      id: entry.path,
      label: entry.name.replace(/\.md$/i, ""),
      icon:
        entry.kind === "folder" ? (
          <Folder size={16} strokeWidth={1.5} />
        ) : (
          <FileText size={16} strokeWidth={1.5} />
        ),
      ...(entry.kind === "folder" ? { children: toNodes(entry.path) } : {}),
    }));
  };
  return toNodes("");
}

export interface FileTreeProps {
  vault: VaultInfo;
  filesStore: FilesStore;
  /** Open a note (single-click/Enter); tabs land with LOA-75. */
  onOpenNote?: (path: string) => void;
}

export function FileTree({ vault, filesStore, onOpenNote }: FileTreeProps) {
  const entries = filesStore(selectEntries);
  const sort = filesStore(selectSort);
  const error = filesStore(selectTreeError);
  const expanded = filesStore((state) => state.expanded);
  const selected = filesStore((state) => state.selected);
  const renamingPath = filesStore((state) => state.renamingPath);
  const store = filesStore.getState();

  useEffect(() => {
    void filesStore.getState().load(vault.id);
  }, [filesStore, vault.id]);

  const nodes = useMemo(() => buildTree(entries, sort), [entries, sort]);
  const target = [...selected][0] ?? "";
  const targetIsFolder = entries.some((entry) => entry.path === target && entry.kind === "folder");
  const targetFolder = targetIsFolder
    ? target
    : target.includes("/")
      ? target.slice(0, target.lastIndexOf("/"))
      : "";

  return (
    <div className="file-tree" data-testid="file-tree">
      <div className="file-tree__toolbar">
        <SegmentedControl
          aria-label="Sort files"
          value={[sort]}
          onValueChange={(value: string[]) => {
            const next = value[0];
            if (next === "name" || next === "modified") store.setSort(next);
          }}
        >
          <Segment value="name">Name</Segment>
          <Segment value="modified">Modified</Segment>
        </SegmentedControl>
      </div>
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: F2 augments the E07 tree's own keyboard model; the tree inside is the interactive widget. */}
          <div
            className="file-tree__body"
            data-testid="file-tree-body"
            onKeyDown={(event) => {
              if (event.key === "F2" && target) {
                event.preventDefault();
                store.startRename(target);
              }
            }}
          >
            <Tree
              nodes={nodes}
              label="Files"
              height="100%"
              expanded={expanded}
              onExpandedChange={(next) => store.setExpanded(next)}
              selected={selected}
              onSelectedChange={(next) => {
                store.setSelected(next);
                // §3.1: single-selecting a note opens it (folders just select).
                if (next.size === 1) {
                  const only = [...next][0] as string;
                  const isNote = entries.some(
                    (entry) => entry.path === only && entry.kind === "markdown",
                  );
                  if (isNote) onOpenNote?.(only);
                }
              }}
              onOpen={(id) => onOpenNote?.(id)}
              renamingId={renamingPath}
              onRenameCommit={(id, name) => {
                const isMarkdown = entries.some(
                  (entry) => entry.path === id && entry.kind === "markdown",
                );
                const finalName = isMarkdown && !/\.md$/i.test(name) ? `${name}.md` : name;
                void store.commitRename(vault.id, id, finalName);
              }}
              onRenameCancel={() => store.cancelRename()}
            />
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item
            shortcut="⏎"
            disabled={!target || targetIsFolder}
            onClick={() => onOpenNote?.(target)}
          >
            Open
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item onClick={() => void store.createNote(vault.id, targetFolder)}>
            New note
          </ContextMenu.Item>
          <ContextMenu.Item onClick={() => void store.createFolder(vault.id, targetFolder)}>
            New folder
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            shortcut="F2"
            disabled={!target}
            onClick={() => store.startRename(target)}
          >
            Rename
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={!target || targetIsFolder}
            onClick={() => void store.duplicate(vault.id, target)}
          >
            Duplicate
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={!target}
            onClick={() => void navigator.clipboard?.writeText(target)}
          >
            Copy path
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            danger
            disabled={!target || targetIsFolder}
            onClick={() => void store.trash(vault.id, target)}
          >
            Move to trash
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Root>
      {error ? (
        <p className="file-tree__error" role="alert" data-testid="file-tree-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
