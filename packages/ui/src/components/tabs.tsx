/**
 * Tabs (§4.3, LOA-45): app-level (filled rows, editor tab bar) and
 * panel-level (underline, right-panel sections) variants on Base UI Tabs.
 * Arrow keys move focus; `activateOnFocus` picks the activation policy.
 */

import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./button";
import "./compact.css";

type PlainClassName<T> = Omit<T, "className"> & { className?: string };

export type TabsVariant = "app" | "panel";

export interface TabsListProps extends PlainClassName<ComponentProps<typeof BaseTabs.List>> {
  variant?: TabsVariant;
}

function TabsList({ variant = "app", className, children, ...rest }: TabsListProps): ReactNode {
  return (
    <BaseTabs.List className={cx("loam-tabs__list", className)} data-variant={variant} {...rest}>
      {children}
      {variant === "panel" ? <BaseTabs.Indicator className="loam-tabs__indicator" /> : null}
    </BaseTabs.List>
  );
}

function Tab({
  className,
  children,
  ...rest
}: PlainClassName<ComponentProps<typeof BaseTabs.Tab>>): ReactNode {
  return (
    <BaseTabs.Tab className={cx("loam-tab", className)} {...rest}>
      <span>{children}</span>
    </BaseTabs.Tab>
  );
}

function TabsPanel({
  className,
  ...rest
}: PlainClassName<ComponentProps<typeof BaseTabs.Panel>>): ReactNode {
  return <BaseTabs.Panel className={cx("loam-tabs__panel", className)} {...rest} />;
}

export const Tabs = {
  Root: BaseTabs.Root,
  List: TabsList,
  Tab,
  Panel: TabsPanel,
};
