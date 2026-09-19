/**
 * The menu bar, with the behaviour a desktop menu bar is expected to have made
 * explicit instead of left to the primitive.
 *
 *  - **Once a menu is open, the pointer walks the bar.** Radix only switches on
 *    `pointerenter` over a title, and WebView2 does not always deliver one while
 *    a popup is up — its idea of what sits under the pointer goes stale, the
 *    same quirk the pane header works around. So which menu is open is owned
 *    here, and every `pointermove` over a title re-checks it: crossing to the
 *    next title always switches, with no second click.
 *  - **Clicking the open title closes it.** Radix re-opened it, so the only way
 *    out was a click somewhere else.
 *  - **Focus goes back where it was.** Closing used to leave focus on the
 *    title, so the next keystroke went nowhere. Now it returns to whatever had
 *    it — usually a terminal — unless the menu opened something that took it.
 *  - Arrow keys walk the items and, past either end, the neighbouring menus;
 *    type-ahead jumps to an item; F10 opens the bar from anywhere.
 *
 * Items are drawn from the same classes as the right-click menus.
 */

import * as React from "react";
import { Menubar as Primitive } from "radix-ui";
import { CheckIcon, ChevronRightIcon } from "lucide-react";

import {
  MENU_DESTRUCTIVE,
  MENU_ITEM,
  MENU_SURFACE,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

const SURFACE = `${MENU_SURFACE} max-h-(--radix-menubar-content-available-height) origin-(--radix-menubar-content-transform-origin)`;

interface Bar {
  value: string;
  setValue: (value: string) => void;
}

const BarContext = React.createContext<Bar | null>(null);
const MenuContext = React.createContext("");

function Menubar({
  value: controlled,
  onValueChange,
  className,
  ...props
}: Omit<
  React.ComponentProps<typeof Primitive.Root>,
  "value" | "onValueChange" | "defaultValue"
> & {
  /** The open menu's value, or "" when the bar is closed. */
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  const [own, setOwn] = React.useState("");
  const value = controlled ?? own;
  const current = React.useRef(value);
  current.current = value;
  const root = React.useRef<HTMLDivElement | null>(null);
  const focusBefore = React.useRef<Element | null>(null);

  const openedAt = React.useRef(0);

  const setValue = React.useCallback(
    (next: string) => {
      const previous = current.current;
      if (next === previous) return;
      if (next) openedAt.current = performance.now();
      if (!previous && next) focusBefore.current = document.activeElement;
      current.current = next;
      if (controlled === undefined) setOwn(next);
      onValueChange?.(next);

      if (previous && !next) {
        // Two frames: long enough for a dialog the item opened to take focus.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const target = focusBefore.current;
            focusBefore.current = null;
            if (current.current) return;
            const active = document.activeElement;
            const unclaimed =
              !active ||
              active === document.body ||
              Boolean(root.current?.contains(active));
            if (
              unclaimed &&
              target instanceof HTMLElement &&
              target.isConnected &&
              target !== active
            ) {
              target.focus();
            }
          }),
        );
      }
    },
    [controlled, onValueChange],
  );

  /**
   * Closes the primitive asks for. When one menu hands over to the next, focus
   * moves into the new menu and the old menu's dismiss layer reports it as a
   * "close" a few milliseconds later — and a bare close shuts whatever is open,
   * which by then is the menu that just opened. That was the bug where
   * crossing to the next title (or clicking it) closed the whole bar. A close
   * that arrives right after something opened is that echo; real closes (Esc,
   * picking an item, clicking away) never come that fast.
   */
  const onPrimitiveChange = React.useCallback(
    (next: string) => {
      if (!next && performance.now() - openedAt.current < 200) return;
      setValue(next);
    },
    [setValue],
  );

  const bar = React.useMemo(() => ({ value, setValue }), [value, setValue]);

  return (
    <BarContext.Provider value={bar}>
      <Primitive.Root
        ref={root}
        data-slot="menubar"
        value={value}
        onValueChange={onPrimitiveChange}
        loop
        className={cn("flex items-center gap-px", className)}
        {...props}
      />
    </BarContext.Provider>
  );
}

function MenubarMenu({
  value,
  ...props
}: React.ComponentProps<typeof Primitive.Menu> & { value: string }) {
  return (
    <MenuContext.Provider value={value}>
      <Primitive.Menu data-slot="menubar-menu" value={value} {...props} />
    </MenuContext.Provider>
  );
}

function MenubarTrigger({
  className,
  onPointerEnter,
  onPointerMove,
  onPointerDown,
  ...props
}: React.ComponentProps<typeof Primitive.Trigger>) {
  const bar = React.useContext(BarContext);
  const mine = React.useContext(MenuContext);

  /** While any menu is open, being over a title is enough to open it. */
  const walk = () => {
    if (bar && bar.value && bar.value !== mine) bar.setValue(mine);
  };

  return (
    <Primitive.Trigger
      data-slot="menubar-trigger"
      className={cn(
        "flex h-[var(--keel-h-control)] items-center rounded-[var(--keel-r-control)] px-2.5 text-row text-dim outline-none transition-[background-color,color] duration-100 select-none hover:bg-veil-2 hover:text-foreground focus-visible:bg-veil-2 focus-visible:text-foreground data-[state=open]:bg-veil-3 data-[state=open]:text-foreground data-[state=open]:shadow-[inset_0_1px_0_0_var(--keel-sheen)]",
        className,
      )}
      {...props}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        walk();
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        walk();
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        // Runs before Radix's own handler, which would open it again.
        if (bar && event.button === 0 && !event.ctrlKey && bar.value === mine) {
          event.preventDefault();
          bar.setValue("");
        }
      }}
    />
  );
}

function MenubarContent({
  className,
  align = "start",
  sideOffset = 6,
  alignOffset = -2,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        data-slot="menubar-content"
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={8}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          // The bar hands focus back itself; the title must not keep it.
          event.preventDefault();
        }}
        className={cn(SURFACE, "data-[side=bottom]:slide-in-from-top-1", className)}
        {...props}
      />
    </Primitive.Portal>
  );
}

function MenubarItem({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof Primitive.Item> & {
  variant?: "default" | "destructive";
}) {
  return (
    <Primitive.Item
      data-slot="menubar-item"
      data-variant={variant}
      className={cn(MENU_ITEM, MENU_DESTRUCTIVE, className)}
      {...props}
    />
  );
}

function Indicator() {
  return (
    <span className="pointer-events-none absolute left-2.5 grid size-3.5 place-items-center">
      <Primitive.ItemIndicator>
        <CheckIcon className="size-3.5 !text-foreground" />
      </Primitive.ItemIndicator>
    </span>
  );
}

function MenubarCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.CheckboxItem>) {
  return (
    <Primitive.CheckboxItem
      data-slot="menubar-checkbox-item"
      className={cn(MENU_ITEM, "pl-8", className)}
      {...props}
    >
      <Indicator />
      {children}
    </Primitive.CheckboxItem>
  );
}

function MenubarRadioGroup(props: React.ComponentProps<typeof Primitive.RadioGroup>) {
  return <Primitive.RadioGroup data-slot="menubar-radio-group" {...props} />;
}

function MenubarRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.RadioItem>) {
  return (
    <Primitive.RadioItem
      data-slot="menubar-radio-item"
      className={cn(MENU_ITEM, "pl-8", className)}
      {...props}
    >
      <Indicator />
      {children}
    </Primitive.RadioItem>
  );
}

function MenubarLabel({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Label>) {
  return (
    <Primitive.Label
      data-slot="menubar-label"
      className={cn(
        "truncate px-2.5 pb-1 pt-1.5 text-small font-medium text-faint",
        className,
      )}
      {...props}
    />
  );
}

function MenubarSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Separator>) {
  return (
    <Primitive.Separator
      data-slot="menubar-separator"
      className={cn("-mx-1 my-1 h-px bg-line", className)}
      {...props}
    />
  );
}

function MenubarShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="menubar-shortcut"
      className={cn("ml-auto pl-5 text-small tracking-wide text-faint", className)}
      {...props}
    />
  );
}

function MenubarSub(props: React.ComponentProps<typeof Primitive.Sub>) {
  return <Primitive.Sub data-slot="menubar-sub" {...props} />;
}

function MenubarSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.SubTrigger>) {
  return (
    <Primitive.SubTrigger
      data-slot="menubar-sub-trigger"
      className={cn(MENU_ITEM, "data-open:bg-veil-3", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-3.5" />
    </Primitive.SubTrigger>
  );
}

function MenubarSubContent({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.SubContent>) {
  return (
    <Primitive.Portal>
      <Primitive.SubContent
        data-slot="menubar-sub-content"
        collisionPadding={8}
        className={cn(SURFACE, "min-w-[200px]", className)}
        {...props}
      />
    </Primitive.Portal>
  );
}

export {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
};
