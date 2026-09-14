/**
 * Keel's right-click menu, built on Radix ContextMenu.
 *
 * Non-modal on purpose: a modal menu makes the rest of the window inert, so the
 * next click anywhere is spent just closing it. And when the menu closes, focus
 * goes back to whatever had it before — usually a terminal — unless something
 * the menu started (a rename field) has taken it since.
 */

import * as React from "react";
import { ContextMenu as Primitive } from "radix-ui";
import { CheckIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** Whatever had focus when a context menu was asked for. */
let focusBeforeMenu: Element | null = null;

/**
 * Every menu surface in the app — right-click menus and the menu bar — is this
 * one panel, so a command looks the same wherever you reach for it. Only the
 * Radix CSS variables for size and origin differ between the two.
 */
export const MENU_SURFACE =
  "z-50 min-w-[216px] overflow-x-hidden overflow-y-auto rounded-[var(--keel-r-window)] border border-line-strong bg-popover p-1 text-popover-foreground shadow-[var(--keel-lift-strong)] backdrop-blur-[var(--keel-blur-strong)] duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

const SURFACE = `${MENU_SURFACE} max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin)`;

export const MENU_ITEM =
  "relative flex h-[30px] cursor-default items-center gap-2.5 rounded-[var(--keel-r-chip)] px-2.5 text-[13px] text-foreground outline-hidden select-none focus:bg-veil-3 data-disabled:pointer-events-none data-disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:text-dim focus:[&_svg]:text-foreground";

export const MENU_DESTRUCTIVE =
  "data-[variant=destructive]:text-[color:var(--keel-dead)] data-[variant=destructive]:[&_svg]:text-[color:var(--keel-dead)] data-[variant=destructive]:focus:bg-[color-mix(in_srgb,var(--keel-dead)_16%,transparent)]";

const ITEM = MENU_ITEM;

function ContextMenu(props: React.ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root data-slot="context-menu" modal={false} {...props} />;
}

function ContextMenuTrigger({
  onContextMenu,
  ...props
}: React.ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      data-slot="context-menu-trigger"
      onContextMenu={(event) => {
        focusBeforeMenu = document.activeElement;
        onContextMenu?.(event);
      }}
      {...props}
    />
  );
}

function ContextMenuContent({
  className,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        data-slot="context-menu-content"
        collisionPadding={8}
        className={cn(SURFACE, className)}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          event.preventDefault();
          // Only hand focus back if nothing else claimed it in the meantime.
          const current = document.activeElement;
          const unclaimed = !current || current === document.body;
          if (
            unclaimed &&
            focusBeforeMenu instanceof HTMLElement &&
            focusBeforeMenu.isConnected
          ) {
            focusBeforeMenu.focus();
          }
          focusBeforeMenu = null;
        }}
        {...props}
      />
    </Primitive.Portal>
  );
}

function ContextMenuItem({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof Primitive.Item> & {
  variant?: "default" | "destructive";
}) {
  return (
    <Primitive.Item
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(ITEM, MENU_DESTRUCTIVE, className)}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Separator>) {
  return (
    <Primitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-line", className)}
      {...props}
    />
  );
}

function ContextMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Label>) {
  return (
    <Primitive.Label
      data-slot="context-menu-label"
      className={cn(
        "truncate px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-faint",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn("ml-auto pl-5 text-[11px] tracking-wide text-faint", className)}
      {...props}
    />
  );
}

function ContextMenuSub(props: React.ComponentProps<typeof Primitive.Sub>) {
  return <Primitive.Sub data-slot="context-menu-sub" {...props} />;
}

function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.SubTrigger>) {
  return (
    <Primitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      className={cn(ITEM, "data-open:bg-veil-3", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-3.5" />
    </Primitive.SubTrigger>
  );
}

function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.SubContent>) {
  return (
    <Primitive.Portal>
      <Primitive.SubContent
        data-slot="context-menu-sub-content"
        collisionPadding={8}
        className={cn(SURFACE, "min-w-[180px]", className)}
        {...props}
      />
    </Primitive.Portal>
  );
}

function ContextMenuRadioGroup(
  props: React.ComponentProps<typeof Primitive.RadioGroup>,
) {
  return <Primitive.RadioGroup data-slot="context-menu-radio-group" {...props} />;
}

function ContextMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.RadioItem>) {
  return (
    <Primitive.RadioItem
      data-slot="context-menu-radio-item"
      className={cn(ITEM, "pl-8", className)}
      {...props}
    >
      <span className="pointer-events-none absolute left-2.5 grid size-3.5 place-items-center">
        <Primitive.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </Primitive.ItemIndicator>
      </span>
      {children}
    </Primitive.RadioItem>
  );
}

function ContextMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.CheckboxItem>) {
  return (
    <Primitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      className={cn(ITEM, "pl-8", className)}
      {...props}
    >
      <span className="pointer-events-none absolute left-2.5 grid size-3.5 place-items-center">
        <Primitive.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </Primitive.ItemIndicator>
      </span>
      {children}
    </Primitive.CheckboxItem>
  );
}

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
};
