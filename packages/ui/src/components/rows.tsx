/**
 * Row primitives (§4.3, LOA-50): 28 px ListRow (sidebar) and 40 px
 * ResultRow (omnibar/search share one). Icon/detail/shortcut slots; the
 * shared 2 px accent drop indicator overlays without moving geometry.
 */

import type { ComponentProps, ReactNode } from "react";
import { cx } from "./button";
import "./list.css";

export type DropPosition = "above" | "below" | "into";

export interface ListRowProps extends Omit<ComponentProps<"div">, "children"> {
  /** Row label; optional when `renameProps` replaces it. */
  children?: ReactNode;
  icon?: ReactNode | undefined;
  /** Right-aligned secondary text (count, date). */
  detail?: ReactNode | undefined;
  shortcut?: string | undefined;
  selected?: boolean | undefined;
  /** Keyboard-active row (aria-activedescendant target). */
  active?: boolean | undefined;
  /** Shows the shared drop indicator without shifting the row. */
  drop?: DropPosition | undefined;
  /** Inline-rename mode: renders an input in place of the label. */
  renameProps?: ComponentProps<"input"> | undefined;
}

export function ListRow({
  children,
  icon,
  detail,
  shortcut,
  selected,
  active,
  drop,
  renameProps,
  className,
  ...rest
}: ListRowProps): ReactNode {
  return (
    <div
      className={cx("loam-list-row", className)}
      data-selected={selected || undefined}
      data-active={active || undefined}
      data-drop={drop}
      {...rest}
    >
      {icon ? (
        <span className="loam-list-row__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {renameProps ? (
        <input className="loam-list-row__rename" {...renameProps} />
      ) : (
        <span className="loam-list-row__label">{children}</span>
      )}
      {detail !== undefined && !renameProps ? (
        <span className="loam-list-row__detail">{detail}</span>
      ) : null}
      {shortcut && !renameProps ? (
        <span className="loam-list-row__shortcut">{shortcut}</span>
      ) : null}
      {drop === "above" || drop === "below" ? <span className="loam-drop-indicator" /> : null}
    </div>
  );
}

export interface ResultRowProps extends Omit<ComponentProps<"div">, "children" | "title"> {
  title: ReactNode;
  /** Second line (path, snippet). */
  detail?: ReactNode | undefined;
  icon?: ReactNode | undefined;
  /** Right column (shortcut or meta). */
  meta?: ReactNode | undefined;
  selected?: boolean | undefined;
  active?: boolean | undefined;
}

export function ResultRow({
  title,
  detail,
  icon,
  meta,
  selected,
  active,
  className,
  ...rest
}: ResultRowProps): ReactNode {
  return (
    <div
      className={cx("loam-result-row", className)}
      data-selected={selected || undefined}
      data-active={active || undefined}
      {...rest}
    >
      {icon ? (
        <span className="loam-result-row__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="loam-result-row__body">
        <span className="loam-result-row__title">{title}</span>
        {detail ? <span className="loam-result-row__detail">{detail}</span> : null}
      </span>
      {meta ? <span className="loam-result-row__meta">{meta}</span> : null}
    </div>
  );
}
