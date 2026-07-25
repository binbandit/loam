/**
 * Large-note notice (LOA-88, §3.2/§5.6). Non-blocking and dismissible: the
 * note is open and editable behind it — the notice only explains why the
 * mode is pinned to Source.
 */

import { IconButton } from "@loam-app/ui";
import { X } from "lucide-react";
import { sizeNotice } from "../editor/policy";
import type { Tab } from "../stores/tabs";
import "./shell.css";

export interface LargeNoteNoticeProps {
  tab: Tab;
  size: number;
  onDismiss: () => void;
}

export function LargeNoteNotice({ tab, size, onDismiss }: LargeNoteNoticeProps) {
  if (tab.noticeDismissed) return null;
  const message = sizeNotice({ size, sizePolicy: tab.sizePolicy });
  if (!message) return null;

  return (
    <div className="size-notice" role="status" data-testid="size-notice">
      <span className="size-notice__text">{message}</span>
      <IconButton label="Dismiss notice" onClick={onDismiss}>
        <X size={12} strokeWidth={1.5} />
      </IconButton>
    </div>
  );
}
