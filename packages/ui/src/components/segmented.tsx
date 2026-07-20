/**
 * Segmented control (§4.3, LOA-45): single-select toggle group on Base UI.
 */

import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import { ToggleGroup as BaseToggleGroup } from "@base-ui/react/toggle-group";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./button";
import "./compact.css";

type PlainClassName<T> = Omit<T, "className"> & { className?: string };

export interface SegmentedControlProps
  extends PlainClassName<ComponentProps<typeof BaseToggleGroup>> {}

export function SegmentedControl({ className, ...rest }: SegmentedControlProps): ReactNode {
  return <BaseToggleGroup className={cx("loam-segmented", className)} {...rest} />;
}

export interface SegmentProps extends PlainClassName<ComponentProps<typeof BaseToggle>> {}

export function Segment({ className, ...rest }: SegmentProps): ReactNode {
  return <BaseToggle className={cx("loam-segmented__item", className)} {...rest} />;
}
