/**
 * Buttons (§4.3, LOA-33): 28 px buttons in four variants, 26 px icon
 * buttons. Loading overlays a spinner without moving geometry (AC4);
 * icon-only buttons require an accessible label (AC2).
 */

import type { ComponentProps, ReactNode } from "react";
import "./controls.css";

export function cx(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  /** Shows a centered spinner and disables the button; width is preserved. */
  loading?: boolean;
  /** Leading 16 px icon. */
  icon?: ReactNode;
  /** Inline shortcut hint, e.g. "⌘⏎". */
  shortcut?: string;
}

export function Button({
  variant = "secondary",
  loading = false,
  icon,
  shortcut,
  className,
  children,
  disabled,
  type,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      type={type ?? "button"}
      className={cx("loam-button", className)}
      data-variant={variant}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      {...rest}
    >
      {icon ? (
        <span className="loam-button__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="loam-button__label">{children}</span>
      {shortcut ? <kbd className="loam-shortcut-hint">{shortcut}</kbd> : null}
      {loading ? (
        <span className="loam-button__spinner" aria-hidden="true">
          <span className="loam-spinner" />
        </span>
      ) : null}
    </button>
  );
}

export interface IconButtonProps extends ComponentProps<"button"> {
  /** Accessible name (icon-only buttons have no visible text). */
  label: string;
  children: ReactNode;
}

export function IconButton({
  label,
  className,
  children,
  type,
  ...rest
}: IconButtonProps): ReactNode {
  if (
    process.env.NODE_ENV !== "production" &&
    !label &&
    !rest["aria-label"] &&
    !rest["aria-labelledby"]
  ) {
    throw new Error(
      "IconButton requires a `label`: icon-only buttons must have an accessible name (§4.6).",
    );
  }
  return (
    <button
      type={type ?? "button"}
      className={cx("loam-icon-button", className)}
      aria-label={label}
      {...rest}
    >
      {children}
    </button>
  );
}
