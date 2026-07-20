/**
 * Split-pane resizer (§4.3, LOA-52): 4 px hit area, accent line while
 * dragging or focused. Pointer drags and arrow keys resize the first pane
 * within [minSize, maxSize]; dragging well below the minimum fires
 * `onCollapse`. E08 composes this into nested layouts.
 */

import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import { cx } from "./button";
import "./split.css";

/** Keyboard resize increment (px per arrow press). */
export const SPLIT_KEYBOARD_STEP = 16;
/** Dragging this far below minSize collapses the pane. */
const COLLAPSE_SLACK = 40;

export interface SplitPaneProps {
  /** Pane flow: `row` = side-by-side (vertical separator). */
  direction?: "row" | "column";
  /** Accessible name for the separator, e.g. "Resize sidebar". */
  label: string;
  children: [ReactNode, ReactNode];
  /** Controlled size (px) of the first pane. */
  size?: number;
  defaultSize?: number;
  onSizeChange?: (size: number) => void;
  minSize?: number;
  maxSize?: number;
  /** Fired when a drag goes well below minSize (§4.4 collapse gesture). */
  onCollapse?: () => void;
  className?: string;
}

export function SplitPane({
  direction = "row",
  label,
  children,
  size: sizeProp,
  defaultSize = 240,
  onSizeChange,
  minSize = 120,
  maxSize = 480,
  onCollapse,
  className,
}: SplitPaneProps): ReactNode {
  const [sizeState, setSizeState] = useState(defaultSize);
  const size = sizeProp ?? sizeState;
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ at: number; size: number } | null>(null);

  const clamp = useCallback(
    (next: number): number => Math.max(minSize, Math.min(maxSize, next)),
    [minSize, maxSize],
  );
  const setSize = useCallback(
    (next: number): void => {
      const clamped = clamp(next);
      setSizeState(clamped);
      onSizeChange?.(clamped);
    },
    [clamp, onSizeChange],
  );

  const axisOf = (event: PointerEvent): number =>
    direction === "row" ? event.clientX : event.clientY;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    dragStart.current = { at: axisOf(event), size };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragStart.current) return;
    const raw = dragStart.current.size + (axisOf(event) - dragStart.current.at);
    if (onCollapse && raw < minSize - COLLAPSE_SLACK) {
      dragStart.current = null;
      setDragging(false);
      onCollapse();
      return;
    }
    setSize(raw);
  };
  const onPointerUp = (): void => {
    dragStart.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const grow = direction === "row" ? "ArrowRight" : "ArrowDown";
    const shrink = direction === "row" ? "ArrowLeft" : "ArrowUp";
    if (event.key === grow) {
      event.preventDefault();
      setSize(size + SPLIT_KEYBOARD_STEP);
    } else if (event.key === shrink) {
      event.preventDefault();
      setSize(size - SPLIT_KEYBOARD_STEP);
    } else if (event.key === "Home") {
      event.preventDefault();
      setSize(minSize);
    } else if (event.key === "End") {
      event.preventDefault();
      setSize(maxSize);
    } else if (event.key === "Enter" && onCollapse) {
      event.preventDefault();
      onCollapse();
    }
  };

  const [first, second] = children;
  return (
    <div className={cx("loam-split", className)} data-direction={direction}>
      <div
        className="loam-split__pane loam-split__pane--fixed"
        style={direction === "row" ? { width: size } : { height: size }}
      >
        {first}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: <hr> cannot be a focusable, draggable window splitter — the ARIA spec's separator (focusable variant) pattern requires a widget element with aria-valuenow. */}
      <div
        role="separator"
        tabIndex={0}
        aria-label={label}
        aria-orientation={direction === "row" ? "vertical" : "horizontal"}
        aria-valuenow={Math.round(size)}
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
        className="loam-split__resizer"
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <span className="loam-split__line" />
      </div>
      <div className="loam-split__pane loam-split__pane--fill">{second}</div>
    </div>
  );
}
