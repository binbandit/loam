/**
 * §5.6 conflict surfaces (LOA-89). The banner is non-blocking (the buffer
 * stays fully editable behind it) with three explicit actions; the merge
 * surface shows mine/disk/base side by side, labeled — never color-only —
 * and writes nothing until an explicit choice.
 */

import { Button, Modal } from "@loam-app/ui";
import { ipc } from "../ipc";
import type { ConflictsStore } from "../stores/conflicts";
import "./shell.css";

export interface ConflictBannerProps {
  conflictsStore: ConflictsStore;
  vaultId: string;
  path: string;
}

export function ConflictBanner({ conflictsStore, vaultId, path }: ConflictBannerProps) {
  const conflict = conflictsStore((state) => state.conflicts[path]);
  const error = conflictsStore((state) => state.errors[path]);
  if (!conflict) return null;
  const store = conflictsStore.getState();

  return (
    <div className="conflict-banner" role="status" data-testid="conflict-banner">
      <span className="conflict-banner__text">
        This note changed on disk while you were editing.
      </span>
      <div className="conflict-banner__actions">
        <Button onClick={() => void store.keepMine(ipc, vaultId, path)}>Keep mine</Button>
        {/* AC3: Take disk only ever runs from this explicit activation. */}
        <Button onClick={() => store.takeDisk(path)}>Take disk</Button>
        <Button variant="ghost" onClick={() => store.openMerge(path)}>
          Merge manually
        </Button>
      </div>
      {error ? (
        <p className="conflict-banner__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface MergeSurfaceProps {
  conflictsStore: ConflictsStore;
  vaultId: string;
}

function MergeColumn({ label, content }: { label: string; content: string | null }) {
  return (
    <section className="merge__column" aria-label={label}>
      <h3 className="merge__label">{label}</h3>
      <pre className="merge__content">{content ?? "(no common base)"}</pre>
    </section>
  );
}

export function MergeSurface({ conflictsStore, vaultId }: MergeSurfaceProps) {
  const merging = conflictsStore((state) => state.merging);
  const conflict = conflictsStore((state) => (merging ? state.conflicts[merging] : undefined));
  const store = conflictsStore.getState();

  return (
    <Modal.Root
      open={merging !== null && conflict !== undefined}
      onOpenChange={(open) => {
        if (!open) store.closeMerge();
      }}
    >
      <Modal.Content className="merge" initialFocus={undefined}>
        <Modal.Title>Merge '{merging?.split("/").at(-1)?.replace(/\.md$/i, "")}'</Modal.Title>
        <Modal.Description>
          Both versions stay untouched until you choose. Copy what you need, then keep one side.
        </Modal.Description>
        {conflict ? (
          <div className="merge__columns" data-testid="merge-columns">
            <MergeColumn label="Mine (editing)" content={conflict.mine} />
            <MergeColumn label="Disk (newer)" content={conflict.disk} />
            <MergeColumn label="Base (common)" content={conflict.base} />
          </div>
        ) : null}
        <Modal.Footer>
          <Modal.Close render={<Button>Keep editing</Button>} />
          <Button
            onClick={() => {
              if (merging) store.takeDisk(merging);
            }}
          >
            Take disk
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (merging) void store.keepMine(ipc, vaultId, merging);
            }}
          >
            Keep mine
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
