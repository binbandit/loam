/**
 * Badge & chip (§4.3, LOA-45): badges for tags/counts, chips for removable
 * tags. Counts use tabular numerals.
 */

import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./button";
import "./compact.css";

export type BadgeVariant = "neutral" | "accent" | "success" | "warning" | "danger";

export interface BadgeProps extends ComponentProps<"span"> {
  variant?: BadgeVariant;
}

export function Badge({ variant = "neutral", className, ...rest }: BadgeProps): ReactNode {
  return <span className={cx("loam-badge", className)} data-variant={variant} {...rest} />;
}

export interface ChipProps {
  children: ReactNode;
  /** Renders a remove button labelled "Remove <label>". */
  onRemove?: () => void;
  /** Plain-text name used for the remove button's accessible label. */
  label?: string;
  className?: string;
}

export function Chip({ children, onRemove, label, className }: ChipProps): ReactNode {
  const name = label ?? (typeof children === "string" ? children : undefined);
  if (process.env.NODE_ENV !== "production" && onRemove && !name) {
    throw new Error("Chip with onRemove needs a plain-text `label` for the remove button (§4.6).");
  }
  return (
    <span className={cx("loam-chip", className)}>
      {children}
      {onRemove ? (
        <button
          type="button"
          className="loam-chip__remove"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <X size={10} strokeWidth={2} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}
