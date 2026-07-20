/** Stories for the split-pane resizer (LOA-52). Rendered per theme by the LOA-53 host. */

import { SplitPane } from "./split";

export default { title: "Primitives / Split" };

const pane = {
  display: "grid",
  placeItems: "center",
  height: "100%",
  background: "var(--loam-bg-panel)",
  color: "var(--loam-text-secondary)",
} as const;

export function RowSplit() {
  return (
    <div style={{ height: 200, border: "1px solid var(--loam-border)", borderRadius: 8 }}>
      <SplitPane label="Resize sidebar" defaultSize={180} minSize={120} maxSize={320}>
        <div style={pane}>sidebar</div>
        <div style={{ ...pane, background: "var(--loam-bg-app)" }}>editor</div>
      </SplitPane>
    </div>
  );
}

export function ColumnSplit() {
  return (
    <div style={{ height: 240, border: "1px solid var(--loam-border)", borderRadius: 8 }}>
      <SplitPane
        direction="column"
        label="Resize preview"
        defaultSize={120}
        minSize={80}
        maxSize={180}
      >
        <div style={pane}>editor</div>
        <div style={{ ...pane, background: "var(--loam-bg-app)" }}>preview</div>
      </SplitPane>
    </div>
  );
}
