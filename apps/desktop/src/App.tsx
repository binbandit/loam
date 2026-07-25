/**
 * App entry (LOA-66): first-run surface until a vault opens, then the shell.
 * Filesystem access goes through packages/ipc-client only; the same tree
 * runs against the native transport in Tauri and the mock in any browser.
 */

import { ThemeProvider } from "@loam-app/ui";
import "@loam-app/ui/fonts.css";
import "@loam-app/ui/tokens.css";
import { useEffect, useState } from "react";
import { editorBench } from "./editor/bench";
import { sessions } from "./editor/sessions";
import { ipc } from "./ipc";
import { AppShell } from "./shell/AppShell";
import { FirstRun } from "./shell/FirstRun";
import { backlinksView } from "./shell/RightPanel";
import { createConflictsStore } from "./stores/conflicts";
import { setDeviceStorage } from "./stores/device-storage";
import { createFilesStore } from "./stores/files";
import { createFindStore } from "./stores/find";
import { createPanelStore } from "./stores/panel";
import { createPanesStore } from "./stores/panes";
import { createSavesStore } from "./stores/saves";
import { createSettingsStore } from "./stores/settings";
import { createStatusStore } from "./stores/status";
import { createVaultStore, selectVault, selectVaultStatus } from "./stores/vault";
import { createWorkspaceStore } from "./stores/workspace";
import { createWorkspaceCoordinator } from "./stores/workspace-file";

// Browser-only test seams: e2e drives external changes/conflicts through the
// mock, and the §5.9 editor benchmark drives the real extension stack.
if (ipc.mock && typeof window !== "undefined") {
  const seam = window as Window & {
    __LOAM_MOCK__?: typeof ipc.mock;
    __LOAM_BENCH__?: typeof editorBench;
  };
  seam.__LOAM_MOCK__ = ipc.mock;
  seam.__LOAM_BENCH__ = editorBench;
}

const vaultStore = createVaultStore(ipc);
const workspaceStore = createWorkspaceStore();
const filesStore = createFilesStore(ipc);
const panesStore = createPanesStore();
const panelStore = createPanelStore([backlinksView]);
const statusStore = createStatusStore();
const settingsStore = createSettingsStore(ipc);
const conflictsStore = createConflictsStore();
const findStore = createFindStore();
const savesStore = createSavesStore(ipc, {
  // Dirty state drives tab indicators (LOA-75) and the §5.6 conflict path.
  onDirtyChange: (path, dirty) => panesStore.getState().markDirty(path, dirty),
  onSaved: (path, hash) => sessions.setBaseHash(path, hash),
});
const workspaceCoordinator = createWorkspaceCoordinator(ipc);

export function App() {
  const [ready, setReady] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const status = vaultStore(selectVaultStatus);
  const vault = vaultStore(selectVault);
  const openFromPicker = vaultStore((state) => state.openFromPicker);
  const openPath = vaultStore((state) => state.openPath);
  const createNew = vaultStore((state) => state.createNew);
  const error = vaultStore((state) => state.error);

  useEffect(() => {
    let cancelled = false;
    ipc.ping().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // §5.5: hydrate per-device workspace.json BEFORE the shell mounts so
  // every store restores through it (LOA-91).
  useEffect(() => {
    if (status !== "open" || !vault) {
      setWorkspaceReady(false);
      return;
    }
    let cancelled = false;
    void workspaceCoordinator.load(vault.id).then(() => {
      if (cancelled) return;
      setDeviceStorage(workspaceCoordinator.storage);
      setWorkspaceReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [status, vault]);

  return (
    <ThemeProvider>
      <div data-testid="app-root" data-ready={ready ? "true" : "false"} data-transport={ipc.kind}>
        {status === "open" && vault && workspaceReady ? (
          <AppShell
            vault={vault}
            workspaceStore={workspaceStore}
            filesStore={filesStore}
            panesStore={panesStore}
            panelStore={panelStore}
            statusStore={statusStore}
            settingsStore={settingsStore}
            conflictsStore={conflictsStore}
            savesStore={savesStore}
            findStore={findStore}
          />
        ) : (
          <FirstRun vault={{ openFromPicker, openPath, createNew, error, status }} />
        )}
      </div>
    </ThemeProvider>
  );
}
