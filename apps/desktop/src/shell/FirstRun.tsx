/**
 * First-run surface (§4.4): no wizard — one quiet screen with exactly three
 * entry paths: "Open folder", "Create new vault", and a drag target.
 */

import { Button } from "@loam-app/ui";
import { type DragEvent, useState } from "react";
import type { VaultState } from "../stores/vault";
import "./shell.css";

export interface FirstRunProps {
  vault: Pick<VaultState, "openFromPicker" | "openPath" | "createNew" | "error" | "status">;
}

export function FirstRun({ vault }: FirstRunProps) {
  const [dragActive, setDragActive] = useState(false);

  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setDragActive(false);
    // Native drops carry absolute paths through the webview; the browser
    // mock maps any dropped folder onto its demo vault via the picker path.
    const item = event.dataTransfer.files.item(0);
    const path = item && "path" in item ? (item as File & { path?: string }).path : undefined;
    if (path) {
      void vault.openPath(path);
    } else {
      void vault.openFromPicker();
    }
  };

  return (
    <div className="first-run" data-testid="first-run">
      <div className="first-run__card">
        <h1 className="first-run__name">Loam</h1>
        <div className="first-run__actions">
          <Button
            variant="primary"
            data-testid="open-vault"
            loading={vault.status === "opening"}
            onClick={() => void vault.openFromPicker()}
          >
            Open folder
          </Button>
          <Button data-testid="create-vault" onClick={() => void vault.createNew()}>
            Create new vault
          </Button>
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a §4.4 drag-drop target has no keyboard equivalent by nature — the two buttons above are the accessible entry paths for the same action. */}
        <div
          className="first-run__drop"
          data-testid="drop-vault"
          data-active={dragActive || undefined}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
        >
          Drag a folder here to open it as a vault
        </div>
        {vault.error ? <p className="first-run__error">{vault.error}</p> : null}
      </div>
    </div>
  );
}
