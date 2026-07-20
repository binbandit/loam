/**
 * Modal & confirm dialog (§4.3/§4.4, LOA-39). Modals are reserved for
 * necessary (destructive) confirmation; Base UI traps focus and restores it
 * to the invoker. `dismissible={false}` blocks Escape/outside dismissal for
 * destructive in-progress states — the explicit buttons still work.
 */

import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Button, cx } from "./button";
import "./overlay.css";

type PlainClassName<T> = Omit<T, "className"> & { className?: string };

type CloseDetails = { reason?: string; cancel: () => void };

/** Blocks Escape/outside/close-watcher dismissal when not dismissible. */
function guardDismissal(
  dismissible: boolean,
  onOpenChange: ((open: boolean) => void) | undefined,
): (open: boolean, details: CloseDetails) => void {
  return (open, details) => {
    if (
      !open &&
      !dismissible &&
      (details.reason === "escape-key" ||
        details.reason === "outside-press" ||
        details.reason === "close-watcher")
    ) {
      details.cancel();
      return;
    }
    onOpenChange?.(open);
  };
}

export interface ModalContentProps {
  children: ReactNode;
  className?: string;
  /** Focus-trap entry override, forwarded to the popup. */
  initialFocus?: ComponentProps<typeof BaseDialog.Popup>["initialFocus"];
}

function ModalContent({ children, className, initialFocus }: ModalContentProps): ReactNode {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="loam-backdrop" />
      <BaseDialog.Popup className={cx("loam-modal", className)} initialFocus={initialFocus}>
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

function ModalTitle({
  className,
  ...rest
}: PlainClassName<ComponentProps<typeof BaseDialog.Title>>): ReactNode {
  return <BaseDialog.Title className={cx("loam-modal__title", className)} {...rest} />;
}

function ModalDescription({
  className,
  ...rest
}: PlainClassName<ComponentProps<typeof BaseDialog.Description>>): ReactNode {
  return <BaseDialog.Description className={cx("loam-modal__description", className)} {...rest} />;
}

function ModalFooter({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): ReactNode {
  return <div className={cx("loam-modal__footer", className)}>{children}</div>;
}

export interface ModalRootProps
  extends Omit<ComponentProps<typeof BaseDialog.Root>, "onOpenChange"> {
  /** When false, Escape and outside clicks do not close the modal. */
  dismissible?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function ModalRoot({ dismissible = true, onOpenChange, ...rest }: ModalRootProps): ReactNode {
  return (
    <BaseDialog.Root
      modal
      disablePointerDismissal={!dismissible}
      onOpenChange={guardDismissal(dismissible, onOpenChange)}
      {...rest}
    />
  );
}

export const Modal = {
  Root: ModalRoot,
  Trigger: BaseDialog.Trigger,
  Close: BaseDialog.Close,
  Content: ModalContent,
  Title: ModalTitle,
  Description: ModalDescription,
  Footer: ModalFooter,
};

export interface ConfirmDialogProps {
  /** Optional trigger element; otherwise control with `open`. */
  trigger?: ReactElement;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** §4.5: the button says what it does ("Rename 143 links", not "Confirm"). */
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive confirmation → danger button. */
  danger?: boolean;
  /** When false, Escape/outside cannot dismiss; buttons still work. */
  dismissible?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  trigger,
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  dismissible = true,
  onConfirm,
}: ConfirmDialogProps): ReactNode {
  return (
    <BaseAlertDialog.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={guardDismissal(dismissible, onOpenChange)}
    >
      {trigger ? <BaseAlertDialog.Trigger render={trigger} /> : null}
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className="loam-backdrop" />
        <BaseAlertDialog.Popup className="loam-modal">
          <BaseAlertDialog.Title className="loam-modal__title">{title}</BaseAlertDialog.Title>
          {description ? (
            <BaseAlertDialog.Description className="loam-modal__description">
              {description}
            </BaseAlertDialog.Description>
          ) : null}
          <div className="loam-modal__footer">
            <BaseAlertDialog.Close render={<Button>{cancelLabel}</Button>} />
            <BaseAlertDialog.Close
              render={
                <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>
                  {confirmLabel}
                </Button>
              }
            />
          </div>
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}
