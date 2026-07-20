/**
 * Choice controls (§4.3, LOA-33): 13 px checkbox, radio, and switch on
 * Base UI (keyboard + ARIA come from the headless layer). Passing children
 * wraps the control in a clickable label row.
 */

import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Check } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./button";
import "./controls.css";

/* Base UI's `className` also accepts a state callback; these primitives are
 * fully styled, so they take plain strings. */
type PlainClassName<T> = Omit<T, "className"> & { className?: string };

function labelled(control: ReactNode, children: ReactNode): ReactNode {
  if (!children) return control;
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Base UI roots render a hidden native input inside the label (their documented labelling pattern); the association is covered by a click-toggles test.
    <label className="loam-choice">
      {control}
      <span className="loam-choice__label">{children}</span>
    </label>
  );
}

export interface CheckboxProps extends PlainClassName<ComponentProps<typeof BaseCheckbox.Root>> {
  children?: ReactNode;
}

export function Checkbox({ children, className, ...rest }: CheckboxProps): ReactNode {
  return labelled(
    <BaseCheckbox.Root className={cx("loam-checkbox", className)} {...rest}>
      <BaseCheckbox.Indicator className="loam-checkbox__indicator">
        <Check size={11} strokeWidth={3} aria-hidden="true" />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>,
    children,
  );
}

export interface SwitchProps extends PlainClassName<ComponentProps<typeof BaseSwitch.Root>> {
  children?: ReactNode;
}

export function Switch({ children, className, ...rest }: SwitchProps): ReactNode {
  return labelled(
    <BaseSwitch.Root className={cx("loam-switch", className)} {...rest}>
      <BaseSwitch.Thumb className="loam-switch__thumb" />
    </BaseSwitch.Root>,
    children,
  );
}

export interface RadioProps extends PlainClassName<ComponentProps<typeof BaseRadio.Root>> {
  children?: ReactNode;
}

export function Radio({ children, className, ...rest }: RadioProps): ReactNode {
  return labelled(
    <BaseRadio.Root className={cx("loam-radio", className)} {...rest}>
      <BaseRadio.Indicator className="loam-radio__indicator" />
    </BaseRadio.Root>,
    children,
  );
}

export type RadioGroupProps = PlainClassName<ComponentProps<typeof BaseRadioGroup>>;

export function RadioGroup({ className, ...rest }: RadioGroupProps): ReactNode {
  return <BaseRadioGroup className={cx("loam-radio-group", className)} {...rest} />;
}
