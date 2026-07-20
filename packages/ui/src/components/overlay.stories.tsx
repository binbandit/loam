/** Stories for overlays & feedback (LOA-39). Rendered per theme by the LOA-53 host. */

import { Link2 } from "lucide-react";
import { Button } from "./button";
import { ConfirmDialog, Modal } from "./dialog";
import { EmptyState, Progress } from "./feedback";
import { Toasts, useToast } from "./toast";

export default { title: "Primitives / Overlay" };

export function ModalStory() {
  return (
    <Modal.Root>
      <Modal.Trigger render={<Button>Rename links</Button>} />
      <Modal.Content>
        <Modal.Title>Rename 143 links</Modal.Title>
        <Modal.Description>Links in 12 notes will be updated to the new name.</Modal.Description>
        <Modal.Footer>
          <Modal.Close render={<Button>Cancel</Button>} />
          <Modal.Close render={<Button variant="primary">Rename 143 links</Button>} />
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

export function ConfirmDialogStory() {
  return (
    <ConfirmDialog
      trigger={<Button variant="danger">Delete note</Button>}
      title="Delete 'Ideas.md'?"
      description="The note moves to the system trash."
      confirmLabel="Delete note"
      danger
      onConfirm={() => {}}
    />
  );
}

function ToastButtons() {
  const toast = useToast();
  return (
    <div style={{ display: "flex", gap: "var(--loam-space-8)" }}>
      <Button
        onClick={() =>
          toast.add({
            title: "Couldn't sync",
            description: "The vault folder is offline.",
            actionProps: { children: "Retry", onClick: () => {} },
          })
        }
      >
        Error toast
      </Button>
      <Button onClick={() => toast.add({ title: "Note duplicated" })}>Plain toast</Button>
    </div>
  );
}

export function ToastStory() {
  return (
    <Toasts>
      <ToastButtons />
    </Toasts>
  );
}

export function EmptyStates() {
  return (
    <EmptyState
      icon={<Link2 size={20} strokeWidth={1.5} />}
      action={<Button variant="ghost">Link a note</Button>}
    >
      No linked mentions yet. Link to this note with [[Note name]].
    </EmptyState>
  );
}

export function ProgressStory() {
  return (
    <div style={{ display: "grid", gap: "var(--loam-space-16)", maxWidth: 320 }}>
      <Progress value={40} label="Indexing vault" />
      <Progress value={null} label="Syncing" />
    </div>
  );
}
