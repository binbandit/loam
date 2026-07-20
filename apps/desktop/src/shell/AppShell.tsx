/**
 * The app shell (LOA-66, §3.5): titlebar, left sidebar, center workspace,
 * right panel, status bar. This story composes the regions with stable
 * landmarks and test IDs; feature content (tree, tabs, panels, status
 * bindings) lands in the following E08 stories.
 */

import type { VaultInfo } from "@loam-app/ipc-client";
import { ConfirmDialog, SplitPane, useTheme } from "@loam-app/ui";
import { useEffect, useState } from "react";
import { ipc } from "../ipc";
import type { ConflictsStore } from "../stores/conflicts";
import type { FilesStore } from "../stores/files";
import { type PanelStore, selectPanelCollapsed } from "../stores/panel";
import { type PanesStore, selectGlobalActiveTab, selectRoot } from "../stores/panes";
import type { SettingsStore } from "../stores/settings";
import type { StatusStore } from "../stores/status";
import { selectLeftSidebar, type WorkspaceStore } from "../stores/workspace";
import { Titlebar } from "../Titlebar";
import { MergeSurface } from "./ConflictBanner";
import { FileTree } from "./FileTree";
import { PaneView } from "./PaneView";
import { RightPanel } from "./RightPanel";
import { SettingsView } from "./SettingsView";
import { StatusBar } from "./StatusBar";
import { runShellCommand, tabCommandForKey } from "./TabBar";
import "./shell.css";

export interface AppShellProps {
  vault: VaultInfo;
  workspaceStore: WorkspaceStore;
  filesStore: FilesStore;
  panesStore: PanesStore;
  panelStore: PanelStore;
  statusStore: StatusStore;
  settingsStore: SettingsStore;
  conflictsStore: ConflictsStore;
}

export function AppShell({
  vault,
  workspaceStore,
  filesStore,
  panesStore,
  panelStore,
  statusStore,
  settingsStore,
  conflictsStore,
}: AppShellProps) {
  const leftSidebar = workspaceStore(selectLeftSidebar);
  const setLeftSidebarWidth = workspaceStore((state) => state.setLeftSidebarWidth);
  const toggleLeftSidebar = workspaceStore((state) => state.toggleLeftSidebar);
  const panelCollapsed = panelStore(selectPanelCollapsed);
  const panelWidth = panelStore((state) => state.width);
  const activeTab = panesStore(selectGlobalActiveTab);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { setMode } = useTheme();
  const themeSetting = settingsStore((state) => state.values["appearance.theme"]);

  // Settings + theme: load per vault, apply the theme setting live.
  useEffect(() => {
    void settingsStore.getState().load(vault.id);
  }, [settingsStore, vault.id]);
  useEffect(() => {
    if (themeSetting === "dark" || themeSetting === "light" || themeSetting === "system") {
      setMode(themeSetting);
    }
  }, [themeSetting, setMode]);

  const root = panesStore(selectRoot);
  const pendingClose = panesStore((state) => state.pendingClose);
  const filesLoading = filesStore((state) => state.loading);

  // Restore the persisted pane layout once the vault enumeration is in
  // (missing notes are dropped safely, AC5).
  useEffect(() => {
    if (filesLoading) return;
    panesStore
      .getState()
      .load(vault.id, new Set(filesStore.getState().entries.map((entry) => entry.path)));
  }, [panesStore, filesStore, vault.id, filesLoading]);

  // §3.5 shortcuts dispatch the same commands as the pointer paths.
  useEffect(() => {
    panelStore.getState().load(vault.id);
  }, [panelStore, vault.id]);

  // §5.6 conflicts: dirty check against the pane tree; clean external
  // changes silently reload previews and refresh the file tree.
  useEffect(() => {
    const isDirty = (path: string): boolean => {
      const walk = (node: import("../stores/panes").PaneNode): boolean => {
        if (node.kind === "pane") {
          return node.tabs.some((tab) => tab.path === path && tab.dirty);
        }
        return walk(node.first) || walk(node.second);
      };
      return walk(panesStore.getState().root);
    };
    const subscription = conflictsStore.getState().start(ipc, vault.id, isDirty);
    const treeRefresh = ipc.listen<{ origin: string }>("vault://file-changed", (envelope) => {
      if (envelope.vaultId !== vault.id) return;
      if (envelope.payload.origin === "external") void filesStore.getState().load(vault.id);
    });
    return () => {
      void subscription.then((unsubscribe) => unsubscribe());
      void treeRefresh.then((unsubscribe) => unsubscribe());
    };
  }, [conflictsStore, panesStore, filesStore, vault.id]);

  // Index status: seed from the vault, then follow §5.4 progress events.
  useEffect(() => {
    const subscription = statusStore.getState().start(ipc, vault.id, vault.indexStatus);
    return () => {
      void subscription.then((unsubscribe) => unsubscribe());
    };
  }, [statusStore, vault.id, vault.indexStatus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // ⌘. toggles the right panel (LOA-80).
      if ((event.metaKey || event.ctrlKey) && event.key === ".") {
        event.preventDefault();
        panelStore.getState().toggle();
        return;
      }
      // ⌘, opens settings (LOA-86); Escape closes via the modal itself.
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      const command = tabCommandForKey(event);
      if (!command) return;
      event.preventDefault();
      runShellCommand(
        panesStore,
        command,
        new Set(filesStore.getState().entries.map((entry) => entry.path)),
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panesStore, filesStore, panelStore]);

  const workspace = (
    <main className="shell__workspace" data-testid="workspace" tabIndex={-1}>
      <PaneView
        node={root}
        vault={vault}
        panesStore={panesStore}
        onActiveContent={(content) => statusStore.getState().setNoteContent(content)}
        conflictsStore={conflictsStore}
      />
      <ConfirmDialog
        open={pendingClose !== null}
        onOpenChange={(open) => {
          if (!open) panesStore.getState().cancelPendingClose();
        }}
        title={`Close '${pendingClose?.tab.title ?? ""}'?`}
        description="The note has unsaved changes."
        confirmLabel="Close without saving"
        cancelLabel="Keep editing"
        danger
        onConfirm={() => panesStore.getState().confirmPendingClose()}
      />
    </main>
  );

  const centerAndRight = panelCollapsed ? (
    workspace
  ) : (
    <SplitPane
      direction="row"
      primary="end"
      label="Resize note panels"
      defaultSize={panelWidth}
      minSize={200}
      maxSize={420}
      onSizeChange={(size) => panelStore.getState().setWidth(size)}
    >
      {[
        workspace,
        <aside
          key="panel"
          className="shell__panel"
          aria-label="Note panels"
          data-testid="right-panel"
        >
          <RightPanel
            panelStore={panelStore}
            vaultId={vault.id}
            activeNotePath={activeTab?.path ?? null}
          />
        </aside>,
      ]}
    </SplitPane>
  );

  return (
    <div className="shell" data-testid="app-shell">
      <Titlebar
        vaultName={vault.name}
        breadcrumb={
          activeTab?.path ? activeTab.path.replace(/\.md$/i, "").split("/").join(" / ") : ""
        }
      />
      <div className="shell__body">
        {leftSidebar.collapsed ? (
          centerAndRight
        ) : (
          <SplitPane
            direction="row"
            label="Resize sidebar"
            defaultSize={leftSidebar.width}
            minSize={160}
            maxSize={400}
            onSizeChange={setLeftSidebarWidth}
            onCollapse={toggleLeftSidebar}
          >
            {[
              <nav
                key="sidebar"
                className="shell__sidebar"
                aria-label="Files"
                data-testid="left-sidebar"
              >
                <FileTree
                  vault={vault}
                  filesStore={filesStore}
                  onOpenNote={(path) => panesStore.getState().openPath(path)}
                />
              </nav>,
              centerAndRight,
            ]}
          </SplitPane>
        )}
      </div>
      <StatusBar statusStore={statusStore} vaultName={vault.name} />
      <SettingsView
        settingsStore={settingsStore}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
      <MergeSurface conflictsStore={conflictsStore} vaultId={vault.id} />
    </div>
  );
}
