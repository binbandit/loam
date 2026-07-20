/**
 * Right panel (LOA-80): collapsible tabbed view host. Views register
 * through the store (the shape plugin views reuse); the built-in Backlinks
 * view binds to the active note behind the generation-guarded data
 * boundary — content itself arrives with E11's links engine.
 */

import { EmptyState, Tabs } from "@loam-app/ui";
import { Link2 } from "lucide-react";
import { useEffect } from "react";
import { type PanelStore, type PanelViewRegistration, selectPanelViews } from "../stores/panel";
import "./shell.css";

/** Built-in Backlinks view (§4.5 empty-state copy until E11 delivers data). */
export const backlinksView: PanelViewRegistration = {
  id: "backlinks",
  title: "Backlinks",
  render: ({ activeNotePath }) =>
    activeNotePath ? (
      <EmptyState icon={<Link2 size={20} strokeWidth={1.5} />}>
        No linked mentions yet. Link to this note with [[Note name]].
      </EmptyState>
    ) : (
      <EmptyState>Open a note to see its backlinks.</EmptyState>
    ),
};

export interface RightPanelProps {
  panelStore: PanelStore;
  vaultId: string;
  activeNotePath: string | null;
}

export function RightPanel({ panelStore, vaultId, activeNotePath }: RightPanelProps) {
  const views = panelStore(selectPanelViews);
  const activeViewId = panelStore((state) => state.activeViewId);
  const generation = panelStore((state) => state.generation);

  // AC2: a new active note bumps the request generation.
  useEffect(() => {
    panelStore.getState().setActiveNote(activeNotePath);
  }, [panelStore, activeNotePath]);

  return (
    <Tabs.Root
      value={activeViewId}
      onValueChange={(value) => panelStore.getState().setActiveView(String(value))}
    >
      <Tabs.List variant="panel" aria-label="Note panels">
        {views.map((view) => (
          <Tabs.Tab key={view.id} value={view.id}>
            {view.title}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {views.map((view) => (
        <Tabs.Panel key={view.id} value={view.id} className="right-panel__view">
          <div data-generation={generation} data-testid={`panel-view-${view.id}`}>
            {view.render({ vaultId, activeNotePath })}
          </div>
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}
