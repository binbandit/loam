/**
 * Slider (§4.3, LOA-45): thin 2 px track on Base UI Slider — keyboard
 * increments, formatted value text, and an optional inline readout.
 */

import { Slider as BaseSlider } from "@base-ui/react/slider";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./button";
import "./compact.css";

export interface SliderProps
  extends Omit<ComponentProps<typeof BaseSlider.Root>, "className" | "children"> {
  /** Accessible name for the slider thumb. */
  label: string;
  /** Shows the formatted value next to the track. */
  showValue?: boolean;
  className?: string;
}

export function Slider({ label, showValue = false, className, ...rest }: SliderProps): ReactNode {
  return (
    <BaseSlider.Root className={cx("loam-slider", className)} {...rest}>
      <BaseSlider.Control className="loam-slider__control">
        <BaseSlider.Track className="loam-slider__track">
          <BaseSlider.Indicator className="loam-slider__indicator" />
          <BaseSlider.Thumb className="loam-slider__thumb" aria-label={label} />
        </BaseSlider.Track>
      </BaseSlider.Control>
      {showValue ? <BaseSlider.Value className="loam-slider__value" /> : null}
    </BaseSlider.Root>
  );
}
