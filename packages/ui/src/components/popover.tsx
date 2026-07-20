/**
 * Popover (§4.3, LOA-37): Base UI popover with §4.2 radius/elevation and an
 * anchor-side entrance. The positioner flips and shifts to stay inside the
 * viewport (Floating UI collision handling) while staying anchored.
 */

import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./button";
import "./floating.css";

type PlainClassName<T> = Omit<T, "className"> & { className?: string };

export interface PopoverContentProps {
  children: ReactNode;
  className?: string;
  side?: ComponentProps<typeof BasePopover.Positioner>["side"];
  align?: ComponentProps<typeof BasePopover.Positioner>["align"];
  sideOffset?: number;
  /** Initial-focus override, forwarded to the popup. */
  initialFocus?: ComponentProps<typeof BasePopover.Popup>["initialFocus"];
}

function PopoverContent({
  children,
  className,
  side = "bottom",
  align,
  sideOffset = 6,
  initialFocus,
}: PopoverContentProps): ReactNode {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
      >
        <BasePopover.Popup className={cx("loam-popover", className)} initialFocus={initialFocus}>
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}

function PopoverTitle({
  className,
  ...rest
}: PlainClassName<ComponentProps<typeof BasePopover.Title>>): ReactNode {
  return <BasePopover.Title className={cx("loam-popover__title", className)} {...rest} />;
}

function PopoverDescription({
  className,
  ...rest
}: PlainClassName<ComponentProps<typeof BasePopover.Description>>): ReactNode {
  return (
    <BasePopover.Description className={cx("loam-popover__description", className)} {...rest} />
  );
}

export const Popover = {
  Root: BasePopover.Root,
  Trigger: BasePopover.Trigger,
  Close: BasePopover.Close,
  Content: PopoverContent,
  Title: PopoverTitle,
  Description: PopoverDescription,
};
