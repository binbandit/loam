/**
 * Virtualized list utility (§4.3, LOA-50) on TanStack Virtual — shared by
 * tree, search, backlinks, and the omnibar. Fixed row heights give stable
 * measurement; only the visible window plus overscan is mounted.
 *
 * Focus model: the scroll container itself is the single tab stop and keeps
 * DOM focus; the active row is exposed via `aria-activedescendant`. Rows can
 * therefore unmount freely while scrolling without dropping keyboard focus.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { cx } from "./button";
import "./list.css";

export interface VirtualListRenderState {
  index: number;
  active: boolean;
  /** Stable DOM id for aria-activedescendant wiring. */
  domId: string;
}

export interface VirtualListProps {
  count: number;
  /** Fixed row height in px (28 sidebar, 40 omnibar). */
  rowHeight: number;
  renderRow: (state: VirtualListRenderState) => ReactNode;
  /** Accessible name of the container. */
  label: string;
  role?: "listbox" | "list" | "tree" | "menu" | undefined;
  /** Active (keyboard) row index, controlled. */
  activeIndex?: number | undefined;
  onActiveIndexChange?: ((index: number) => void) | undefined;
  /** Row activation (Enter). */
  onRowActivate?: ((index: number) => void) | undefined;
  overscan?: number | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  /** Extra ARIA attributes for the container (e.g. aria-multiselectable). */
  containerProps?: Record<string, unknown> | undefined;
  /** Keyboard fallthrough for roles with extra bindings (tree arrows). */
  onKeyDownCapture?: ((event: KeyboardEvent<HTMLDivElement>) => boolean) | undefined;
}

export function VirtualList({
  count,
  rowHeight,
  renderRow,
  label,
  role = "list",
  activeIndex,
  onActiveIndexChange,
  onRowActivate,
  overscan = 8,
  className,
  style,
  containerProps,
  onKeyDownCapture,
}: VirtualListProps): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  const idBase = useId();
  const domId = (index: number): string => `${idBase}-row-${index}`;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  // Keep the active row mounted/visible when it changes.
  useEffect(() => {
    if (activeIndex !== undefined && activeIndex >= 0 && activeIndex < count) {
      virtualizer.scrollToIndex(activeIndex);
    }
  }, [activeIndex, count, virtualizer]);

  const move = (next: number): void => {
    const clamped = Math.max(0, Math.min(count - 1, next));
    onActiveIndexChange?.(clamped);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (onKeyDownCapture?.(event)) return;
    const current = activeIndex ?? -1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(current + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(current - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(count - 1);
        break;
      case "Enter":
        if (current >= 0) {
          event.preventDefault();
          onRowActivate?.(current);
        }
        break;
      default:
        break;
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: virtualization container; its role comes from the composite widget (listbox/tree) it hosts.
    // biome-ignore lint/a11y/noStaticElementInteractions: the dynamic `role` prop makes this the interactive composite (listbox/tree); keyboard handling lives here by design (aria-activedescendant roving).
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label is valid for every role this container accepts (listbox/list/tree/menu); the linter cannot see through the dynamic role prop.
    <div
      ref={scrollRef}
      role={role}
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={
        activeIndex !== undefined && activeIndex >= 0 ? domId(activeIndex) : undefined
      }
      className={cx("loam-virtual", className)}
      style={style}
      onKeyDown={onKeyDown}
      {...containerProps}
    >
      <div
        role="presentation"
        className="loam-virtual__spacer"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            role="presentation"
            className="loam-virtual__row"
            style={{ height: item.size, transform: `translateY(${item.start}px)` }}
          >
            {renderRow({
              index: item.index,
              active: item.index === activeIndex,
              domId: domId(item.index),
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
