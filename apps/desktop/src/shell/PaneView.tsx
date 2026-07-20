/**
 * Recursive pane layout view (LOA-76, §3.5). Splits render through the E07
 * resizer; leaves render a tab strip + note surface with drag-to-edge split
 * targets (shared §4.4 accent indicator). The active pane carries a subtle
 * top accent border.
 */

import type { VaultInfo } from "@loam-app/ipc-client";
import { SplitPane } from "@loam-app/ui";
import { type DragEvent, useState } from "react";
import type { ConflictsStore } from "../stores/conflicts";
import {
  type PaneNode,
  type PanesStore,
  type SplitDirection,
  selectActivePaneId,
} from "../stores/panes";
import { ConflictBanner } from "./ConflictBanner";
import { NotePreview } from "./NotePreview";
import { TabBar } from "./TabBar";
import "./shell.css";

const TAB_MIME = "application/x-loam-tab";

export interface PaneViewProps {
  node: PaneNode;
  vault: VaultInfo;
  panesStore: PanesStore;
  /** Active-pane note content sink (status counts, LOA-84). */
  onActiveContent?: ((content: string | null) => void) | undefined;
  conflictsStore: ConflictsStore;
}

export function PaneView({
  node,
  vault,
  panesStore,
  onActiveContent,
  conflictsStore,
}: PaneViewProps) {
  const activePaneId = panesStore(selectActivePaneId);
  const activeLeafTabPath =
    node.kind === "pane"
      ? (node.tabs.find((tab) => tab.id === node.activeTabId)?.path ?? null)
      : null;
  const reloadGeneration = conflictsStore((state) =>
    activeLeafTabPath ? (state.reloadGeneration[activeLeafTabPath] ?? 0) : 0,
  );
  const [edge, setEdge] = useState<SplitDirection | null>(null);

  if (node.kind === "split") {
    return (
      <SplitPane
        direction={node.direction}
        label={node.direction === "row" ? "Resize panes" : "Resize stacked panes"}
        defaultSize={node.size}
        minSize={200}
        maxSize={1200}
        onSizeChange={(size) => panesStore.getState().setSplitSize(node.id, size)}
      >
        {[
          <PaneView
            key={node.first.id}
            node={node.first}
            vault={vault}
            panesStore={panesStore}
            onActiveContent={onActiveContent}
            conflictsStore={conflictsStore}
          />,
          <PaneView
            key={node.second.id}
            node={node.second}
            vault={vault}
            panesStore={panesStore}
            onActiveContent={onActiveContent}
            conflictsStore={conflictsStore}
          />,
        ]}
      </SplitPane>
    );
  }

  const activeTab = node.tabs.find((tab) => tab.id === node.activeTabId) ?? null;

  const dropDirection = (event: DragEvent): SplitDirection | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fromRight = rect.right - event.clientX;
    const fromBottom = rect.bottom - event.clientY;
    if (fromRight < 80) return "row";
    if (fromBottom < 80) return "column";
    return null;
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-to-edge split is a pointer affordance; splits are keyboard-reachable via ⌘\ and the pane commands.
    <section
      className="pane"
      data-testid={`pane-${node.id}`}
      data-active={node.id === activePaneId || undefined}
      data-drop-edge={edge ?? undefined}
      aria-label="Note pane"
      onFocusCapture={() => panesStore.getState().focusPane(node.id)}
      onClickCapture={() => panesStore.getState().focusPane(node.id)}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(TAB_MIME)) return;
        const direction = dropDirection(event);
        if (direction) event.preventDefault();
        setEdge(direction);
      }}
      onDragLeave={() => setEdge(null)}
      onDrop={(event) => {
        const payload = event.dataTransfer.getData(TAB_MIME);
        const direction = dropDirection(event);
        setEdge(null);
        if (!payload || !direction) return;
        event.preventDefault();
        event.stopPropagation();
        const { paneId, tabId } = JSON.parse(payload) as { paneId: string; tabId: string };
        panesStore.getState().splitWithTab(paneId, tabId, node.id, direction);
      }}
    >
      <TabBar panesStore={panesStore} paneId={node.id} />
      {activeTab?.path ? (
        <ConflictBanner conflictsStore={conflictsStore} vaultId={vault.id} path={activeTab.path} />
      ) : null}
      {activeTab?.path ? (
        <NotePreview
          key={activeTab.path}
          vault={vault}
          path={activeTab.path}
          onContent={node.id === activePaneId ? onActiveContent : undefined}
          reloadGeneration={reloadGeneration}
        />
      ) : (
        <p className="shell__placeholder">No note open. The editor arrives with E09.</p>
      )}
      {edge ? <span className="pane__edge-indicator" data-edge={edge} /> : null}
    </section>
  );
}
