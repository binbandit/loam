/**
 * Toasts (§4.3/§4.4, LOA-39): bottom-right, max 3 stacked, 5 s auto-dismiss,
 * hover pauses, optional action ("Open folder", "Retry"). Base UI's manager
 * announces via a polite live region without moving focus. Wrap the app in
 * `Toasts` and fire with `useToast().add(...)`.
 */

import { Toast as BaseToast } from "@base-ui/react/toast";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { IconButton } from "./button";
import "./overlay.css";

/** §4.3: toasts auto-dismiss after 5 s. */
export const TOAST_TIMEOUT_MS = 5000;
/** §4.3: at most 3 toasts stack. */
export const TOAST_LIMIT = 3;

/** Fire toasts from components: `useToast().add({ title, ... })`. */
export const useToast = BaseToast.useToastManager;

function ToastList(): ReactNode {
  const { toasts } = BaseToast.useToastManager();
  return toasts.map((toast) => (
    <BaseToast.Root key={toast.id} toast={toast} className="loam-toast">
      <BaseToast.Content className="loam-toast__content">
        <BaseToast.Title className="loam-toast__title" />
        <BaseToast.Description className="loam-toast__description" />
      </BaseToast.Content>
      {toast.actionProps ? (
        <BaseToast.Action className="loam-toast__action loam-button" data-variant="ghost" />
      ) : null}
      <BaseToast.Close
        render={
          <IconButton label="Dismiss" className="loam-toast__close">
            <X size={14} strokeWidth={1.5} />
          </IconButton>
        }
      />
    </BaseToast.Root>
  ));
}

export interface ToastsProps
  extends Omit<ComponentProps<typeof BaseToast.Provider>, "timeout" | "limit"> {
  timeout?: number;
  limit?: number;
}

/** Provider + bottom-right viewport. Render once around the app. */
export function Toasts({
  children,
  timeout = TOAST_TIMEOUT_MS,
  limit = TOAST_LIMIT,
  ...rest
}: ToastsProps): ReactNode {
  return (
    <BaseToast.Provider timeout={timeout} limit={limit} {...rest}>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport className="loam-toasts">
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}
