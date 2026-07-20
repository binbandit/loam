/**
 * Tooltip (§4.3, LOA-37): 400 ms open delay; wrapping a surface in
 * `TooltipProvider` makes tooltips instant when moving between nearby
 * targets (Base UI's provider grouping). Optionally shows a shortcut.
 */

import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cx } from "./button";
import "./floating.css";

/** §4.3: tooltips open after 400 ms. */
export const TOOLTIP_DELAY_MS = 400;

export type TooltipProviderProps = ComponentProps<typeof BaseTooltip.Provider>;

/** Groups tooltips so moving between targets shows them instantly. */
export function TooltipProvider({
  delay = TOOLTIP_DELAY_MS,
  timeout = TOOLTIP_DELAY_MS,
  ...rest
}: TooltipProviderProps): ReactNode {
  return <BaseTooltip.Provider delay={delay} timeout={timeout} {...rest} />;
}

export interface TooltipProps
  extends Omit<ComponentProps<typeof BaseTooltip.Root>, "children" | "delay"> {
  /** Tooltip text. */
  content: ReactNode;
  /** Optional shortcut shown after the text, e.g. "⌘B". */
  shortcut?: string;
  /** The trigger element. */
  children: ReactElement;
  side?: ComponentProps<typeof BaseTooltip.Positioner>["side"];
  align?: ComponentProps<typeof BaseTooltip.Positioner>["align"];
  className?: string;
  delay?: number;
}

export function Tooltip({
  content,
  shortcut,
  children,
  side = "top",
  align,
  className,
  delay = TOOLTIP_DELAY_MS,
  ...rest
}: TooltipProps): ReactNode {
  return (
    <BaseTooltip.Root {...rest}>
      <BaseTooltip.Trigger render={children} delay={delay} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} align={align} sideOffset={6} collisionPadding={8}>
          <BaseTooltip.Popup className={cx("loam-tooltip", className)}>
            {content}
            {shortcut ? <kbd className="loam-tooltip__shortcut">{shortcut}</kbd> : null}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
