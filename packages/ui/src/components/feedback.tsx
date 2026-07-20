/**
 * Empty state & progress (§4.3/§4.5, LOA-39). Empty states are invitations:
 * one line + one action. Progress is a thin 2 px accent bar; indeterminate
 * is reserved for network work and goes static under reduced motion.
 */

import { Progress as BaseProgress } from "@base-ui/react/progress";
import type { ReactNode } from "react";
import { cx } from "./button";
import "./overlay.css";

export interface EmptyStateProps {
  /** The single line of copy (§4.5: an invitation, cause + remedy). */
  children: ReactNode;
  /** The single action, e.g. a ghost Button. */
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({ children, action, icon, className }: EmptyStateProps): ReactNode {
  return (
    <div className={cx("loam-empty", className)}>
      {icon ? (
        <span className="loam-empty__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="loam-empty__line">{children}</p>
      {action}
    </div>
  );
}

export interface ProgressProps {
  /** 0..max, or null for indeterminate (network work only, §4.3). */
  value: number | null;
  max?: number;
  /** Accessible name for the bar. */
  label: string;
  className?: string;
}

export function Progress({ value, max = 100, label, className }: ProgressProps): ReactNode {
  return (
    <BaseProgress.Root
      className={cx("loam-progress", className)}
      value={value}
      max={max}
      aria-label={label}
      data-indeterminate={value === null || undefined}
    >
      <BaseProgress.Track className="loam-progress__track">
        <BaseProgress.Indicator className="loam-progress__indicator" />
      </BaseProgress.Track>
    </BaseProgress.Root>
  );
}
