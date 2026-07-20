/**
 * Menu & context menu (§4.3, LOA-37): Base UI menus with the Loam shortcut
 * column, submenu flyouts, and built-in type-ahead. `Esc` dismisses and
 * Base UI restores focus to the trigger.
 */

import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./button";
import "./floating.css";

type PlainClassName<T> = Omit<T, "className"> & { className?: string };

export interface MenuContentProps {
  children: ReactNode;
  className?: string;
  side?: ComponentProps<typeof BaseMenu.Positioner>["side"];
  align?: ComponentProps<typeof BaseMenu.Positioner>["align"];
  sideOffset?: number;
}

function popup(
  Parts: typeof BaseMenu | typeof BaseContextMenu,
  { children, className, side, align, sideOffset = 4 }: MenuContentProps,
): ReactNode {
  return (
    <Parts.Portal>
      <Parts.Positioner side={side} align={align} sideOffset={sideOffset} collisionPadding={8}>
        <Parts.Popup className={cx("loam-menu", className)}>{children}</Parts.Popup>
      </Parts.Positioner>
    </Parts.Portal>
  );
}

export interface MenuItemProps extends PlainClassName<ComponentProps<typeof BaseMenu.Item>> {
  /** Leading 16 px icon. */
  icon?: ReactNode | undefined;
  /** Right-aligned shortcut column, e.g. "⌘⌫". */
  shortcut?: string | undefined;
  /** Destructive action treatment. */
  danger?: boolean | undefined;
}

function MenuItem({
  icon,
  shortcut,
  danger,
  className,
  children,
  ...rest
}: MenuItemProps): ReactNode {
  return (
    <BaseMenu.Item
      className={cx("loam-menu__item", className)}
      data-danger={danger || undefined}
      {...rest}
    >
      {icon ? (
        <span className="loam-menu__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="loam-menu__label">{children}</span>
      {shortcut ? <span className="loam-menu__shortcut">{shortcut}</span> : null}
    </BaseMenu.Item>
  );
}

export interface MenuSubmenuTriggerProps
  extends PlainClassName<ComponentProps<typeof BaseMenu.SubmenuTrigger>> {
  icon?: ReactNode;
}

function MenuSubmenuTrigger({
  icon,
  className,
  children,
  ...rest
}: MenuSubmenuTriggerProps): ReactNode {
  return (
    <BaseMenu.SubmenuTrigger className={cx("loam-menu__item", className)} {...rest}>
      {icon ? (
        <span className="loam-menu__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="loam-menu__label">{children}</span>
      <ChevronRight
        className="loam-menu__submenu-caret"
        size={14}
        strokeWidth={1.5}
        aria-hidden="true"
      />
    </BaseMenu.SubmenuTrigger>
  );
}

function MenuSeparator({
  className,
  ...rest
}: PlainClassName<ComponentProps<typeof BaseMenu.Separator>>): ReactNode {
  return <BaseMenu.Separator className={cx("loam-menu__separator", className)} {...rest} />;
}

function MenuGroupLabel({
  className,
  ...rest
}: PlainClassName<ComponentProps<typeof BaseMenu.GroupLabel>>): ReactNode {
  return <BaseMenu.GroupLabel className={cx("loam-menu__group-label", className)} {...rest} />;
}

/** Dropdown menu. `Menu.Content` renders the positioned popup. */
export const Menu = {
  Root: BaseMenu.Root,
  Trigger: BaseMenu.Trigger,
  Content: (props: MenuContentProps) => popup(BaseMenu, props),
  Item: MenuItem,
  Separator: MenuSeparator,
  Group: BaseMenu.Group,
  GroupLabel: MenuGroupLabel,
  Submenu: BaseMenu.SubmenuRoot,
  SubmenuTrigger: MenuSubmenuTrigger,
};

/** Right-click menu over `ContextMenu.Trigger`; items are shared with Menu. */
export const ContextMenu = {
  Root: BaseContextMenu.Root,
  Trigger: BaseContextMenu.Trigger,
  Content: (props: MenuContentProps) => popup(BaseContextMenu, props),
  Item: MenuItem,
  Separator: MenuSeparator,
  Group: BaseContextMenu.Group,
  GroupLabel: MenuGroupLabel,
  Submenu: BaseContextMenu.SubmenuRoot,
  SubmenuTrigger: MenuSubmenuTrigger,
};
