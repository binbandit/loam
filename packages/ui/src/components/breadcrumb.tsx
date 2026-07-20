/**
 * Breadcrumb (§4.3, LOA-45). Long segments truncate visually (CSS ellipsis)
 * while the accessible name stays complete; the separator mirrors in RTL.
 */

import { ChevronRight } from "lucide-react";
import { Children, type ReactNode } from "react";
import { cx } from "./button";
import "./compact.css";

export interface BreadcrumbItemProps {
  children: ReactNode;
  href?: string;
  /** Marks the current page (`aria-current="page"`). */
  current?: boolean;
  onClick?: () => void;
  className?: string;
}

export function BreadcrumbItem({
  children,
  href,
  current = false,
  onClick,
  className,
}: BreadcrumbItemProps): ReactNode {
  const shared = {
    className: cx("loam-breadcrumb__link", className),
    "aria-current": current ? ("page" as const) : undefined,
  };
  if (href || onClick) {
    return (
      <a href={href} onClick={onClick} {...shared}>
        {children}
      </a>
    );
  }
  return <span {...shared}>{children}</span>;
}

export interface BreadcrumbProps {
  children: ReactNode;
  /** Accessible name for the navigation landmark. */
  label?: string;
  className?: string;
}

export function Breadcrumb({
  children,
  label = "Breadcrumb",
  className,
}: BreadcrumbProps): ReactNode {
  const items = Children.toArray(children);
  return (
    <nav aria-label={label} className={cx("loam-breadcrumb", className)}>
      <ol className="loam-breadcrumb__list">
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb segments are positional and never reorder.
          <li key={index} className="loam-breadcrumb__item">
            {item}
            {index < items.length - 1 ? (
              <ChevronRight
                className="loam-breadcrumb__sep"
                size={12}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
