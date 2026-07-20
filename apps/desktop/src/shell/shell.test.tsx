/** LOA-66: first-run surface and shell region composition. */

import { createMockTransport } from "@loam-app/ipc-client";
import { ThemeProvider } from "@loam-app/ui";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { createConflictsStore } from "../stores/conflicts";
import { createFilesStore } from "../stores/files";
import { createPanelStore } from "../stores/panel";
import { createPanesStore } from "../stores/panes";
import { createSettingsStore } from "../stores/settings";
import { createStatusStore } from "../stores/status";
import { createVaultStore } from "../stores/vault";
import { createWorkspaceStore } from "../stores/workspace";
import { AppShell } from "./AppShell";
import { FirstRun } from "./FirstRun";
import { backlinksView } from "./RightPanel";

/** AC1: exactly the three §4.4 entry paths, nothing else. */
describe("first run", () => {
  it("exposes open, create, and drag entries only", () => {
    const store = createVaultStore(createMockTransport());
    render(<FirstRun vault={store.getState()} />);
    expect(screen.getByTestId("open-vault")).toHaveTextContent("Open folder");
    expect(screen.getByTestId("create-vault")).toHaveTextContent("Create new vault");
    expect(screen.getByTestId("drop-vault")).toHaveTextContent(/Drag a folder/);
    // Exactly two buttons + one drop target; no wizard steps.
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});

/** AC2: opening the mock vault replaces first-run with the shell landmarks. */
describe("app composition", () => {
  it("swaps first-run for the shell when the demo vault opens", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByTestId("first-run")).toBeInTheDocument();
    await user.click(screen.getByTestId("open-vault"));
    await waitFor(() => expect(screen.getByTestId("app-shell")).toBeInTheDocument());
    expect(screen.queryByTestId("first-run")).not.toBeInTheDocument();
    // Landmarks (§4.6): banner, files nav, main, status footer.
    expect(screen.getByRole("navigation", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toHaveTextContent("Loam Demo");
  });
});

describe("shell regions", () => {
  const vault = {
    id: "v1",
    name: "Loam Demo",
    readOnly: false,
    transientIdentity: false,
    counts: { notes: 5, folders: 1, attachments: 0 },
    indexStatus: "ready",
  } as const;

  it("renders all five regions with stable test ids", () => {
    const workspaceStore = createWorkspaceStore();
    const panelStore = createPanelStore([backlinksView]);
    panelStore.setState({ collapsed: false });
    render(
      <ThemeProvider>
        <AppShell
          vault={vault}
          workspaceStore={workspaceStore}
          filesStore={createFilesStore(createMockTransport())}
          panesStore={createPanesStore()}
          panelStore={panelStore}
          statusStore={createStatusStore()}
          settingsStore={createSettingsStore(createMockTransport())}
          conflictsStore={createConflictsStore()}
        />
      </ThemeProvider>,
    );
    for (const id of ["app-shell", "left-sidebar", "workspace", "right-panel", "status-bar"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.getByRole("complementary", { name: "Note panels" })).toBeInTheDocument();
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("collapsed panels drop their regions and resizers", () => {
    const workspaceStore = createWorkspaceStore();
    workspaceStore.setState((state) => ({
      leftSidebar: { ...state.leftSidebar, collapsed: true },
    }));
    render(
      <ThemeProvider>
        <AppShell
          vault={vault}
          workspaceStore={workspaceStore}
          filesStore={createFilesStore(createMockTransport())}
          panesStore={createPanesStore()}
          panelStore={createPanelStore([backlinksView])}
          statusStore={createStatusStore()}
          settingsStore={createSettingsStore(createMockTransport())}
          conflictsStore={createConflictsStore()}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId("left-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("right-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace")).toBeInTheDocument();
  });
});
