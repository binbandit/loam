/**
 * Text inputs (§4.3, LOA-33): Input, Textarea, and the search field with
 * its inline ⌘-hint. Invalid state is `aria-invalid` + danger border.
 */

import { Input as BaseInput } from "@base-ui/react/input";
import { Search } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./button";
import "./controls.css";

/* Base UI's `className` also accepts a state callback; these primitives are
 * fully styled, so they take plain strings. */
export interface InputProps extends Omit<ComponentProps<typeof BaseInput>, "className"> {
  className?: string;
  invalid?: boolean;
}

export function Input({ invalid, className, ...rest }: InputProps): ReactNode {
  return (
    <BaseInput
      className={cx("loam-input", className)}
      aria-invalid={invalid || undefined}
      data-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export interface TextareaProps extends ComponentProps<"textarea"> {
  invalid?: boolean;
}

export function Textarea({ invalid, className, ...rest }: TextareaProps): ReactNode {
  return (
    <textarea
      className={cx("loam-textarea", className)}
      aria-invalid={invalid || undefined}
      data-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export interface SearchFieldProps extends InputProps {
  /** Inline shortcut hint on the right, e.g. "⌘K". */
  shortcut?: string;
}

export function SearchField({
  shortcut,
  invalid,
  className,
  ...rest
}: SearchFieldProps): ReactNode {
  return (
    <div className={cx("loam-search", className)} data-invalid={invalid || undefined}>
      <Search className="loam-search__icon" size={16} strokeWidth={1.5} aria-hidden="true" />
      <BaseInput
        type="search"
        className="loam-search__input"
        aria-invalid={invalid || undefined}
        {...rest}
      />
      {shortcut ? <kbd className="loam-shortcut-hint">{shortcut}</kbd> : null}
    </div>
  );
}
