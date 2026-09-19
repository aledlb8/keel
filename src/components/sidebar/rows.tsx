/**
 * The grammar every row in the dock obeys.
 *
 * One kind of row, used at three depths, so there is nothing to learn twice:
 *
 *  - **Click** goes there.
 *  - **Double-click** or **F2** renames it in place.
 *  - **Right-click**, the context-menu key, or the ⋯ that appears on hover opens
 *    everything else. The menus are shared with the panes, so a terminal offers
 *    the same actions wherever you reach for it.
 *  - **Drag** moves it. See `dnd.tsx` for where each thing is allowed to land.
 */

import type { ReactNode } from "react";
import { Ellipsis } from "lucide-react";

import {
  ContextMenuEntries,
  type MenuEntry,
} from "@/components/menu/MenuEntries";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { bindingFor, matchesBinding } from "@/lib/keymap";
import { cn } from "@/lib/utils";
import { useKeel, type RenameTarget } from "@/state/store";
import type { SortableProps } from "./dnd";

export type RowGroup = RenameTarget["kind"];

// Spelled out per group so Tailwind can see every class name.
const GROUP: Record<RowGroup, string> = {
  workspace: "group/workspace",
  project: "group/project",
  deck: "group/deck",
  pane: "group/pane",
};

export const SHOW_ON_HOVER: Record<RowGroup, string> = {
  workspace: "group-hover/workspace:flex group-focus-visible/workspace:flex",
  project: "group-hover/project:flex group-focus-visible/project:flex",
  deck: "group-hover/deck:flex group-focus-visible/deck:flex",
  pane: "group-hover/pane:flex group-focus-visible/pane:flex",
};

export const HIDE_ON_HOVER: Record<RowGroup, string> = {
  workspace: "group-hover/workspace:hidden group-focus-visible/workspace:hidden",
  project: "group-hover/project:hidden group-focus-visible/project:hidden",
  deck: "group-hover/deck:hidden group-focus-visible/deck:hidden",
  pane: "group-hover/pane:hidden group-focus-visible/pane:hidden",
};

export function useRenaming(kind: RowGroup, id: string): boolean {
  return useKeel(
    (state) =>
      state.renaming?.where === "sidebar" &&
      state.renaming.kind === kind &&
      state.renaming.id === id,
  );
}

export function startRename(kind: RowGroup, id: string) {
  useKeel.getState().startRename({ kind, id, where: "sidebar" });
}

export function stopRename() {
  useKeel.getState().stopRename();
}

/** Open a row's context menu from a button inside it, anchored under the button. */
export function openMenuFrom(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left,
      clientY: rect.bottom + 2,
    }),
  );
}

function isControl(target: EventTarget): boolean {
  return target instanceof Element && target.closest("button, input") !== null;
}

/**
 * A row that behaves like one: focusable, activated by Enter or Space, renamed
 * by F2 or a double-click, draggable, and carrying its own context menu.
 */
export function Row({
  group,
  menu,
  name,
  selected,
  inside,
  depth = 0,
  onActivate,
  onRename,
  sortable,
  className,
  title,
  children,
}: {
  group: RowGroup;
  menu: () => MenuEntry[];
  /**
   * What this row is called. Given explicitly because the row's first child is
   * a chevron or a close button, and letting the name be computed from the
   * contents announces it as "Collapse api-server 3".
   */
  name: string;
  /** The one row wearing the fill. */
  selected: boolean;
  /** On the path to the selected row: bright text, no fill. */
  inside?: boolean;
  /** 0, 1 or 2. The dock's whole indent scale, and it stops at two. */
  depth?: 0 | 1 | 2;
  onActivate: () => void;
  onRename: () => void;
  sortable: SortableProps;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          {...sortable}
          role="button"
          tabIndex={0}
          aria-label={name}
          data-selected={selected}
          data-inside={inside ? "true" : undefined}
          data-depth={depth}
          title={title}
          className={cn("k-row", GROUP[group], className)}
          onClick={(event) => {
            if (!isControl(event.target)) onActivate();
          }}
          onDoubleClick={(event) => {
            if (!isControl(event.target)) onRename();
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onActivate();
            } else if (matchesBinding(event, bindingFor("rename"))) {
              event.preventDefault();
              onRename();
            } else if (
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              event.preventDefault();
              openMenuFrom(event.currentTarget);
            }
          }}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuEntries entries={menu} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Quick actions that slide in on hover, replacing the row's quiet detail. */
export function RowActions({
  group,
  children,
}: {
  group: RowGroup;
  children: ReactNode;
}) {
  return (
    <span
      className={cn("hidden shrink-0 items-center gap-px", SHOW_ON_HOVER[group])}
    >
      {children}
    </span>
  );
}

export function RowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: (button: HTMLElement) => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-danger={danger ? "true" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        onClick(event.currentTarget);
      }}
      className="k-icon-btn size-[21px]"
    >
      {children}
    </button>
  );
}

export function MoreButton() {
  return (
    <RowButton label="More actions" onClick={openMenuFrom}>
      <Ellipsis className="size-3.5" />
    </RowButton>
  );
}

/** A tally. Tabular because it is a number you compare down a column. */
export function Count({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  if (!value) return null;
  return (
    <span
      className={cn(
        "shrink-0 pr-0.5 text-small tabular-nums text-faint",
        className,
      )}
    >
      {value}
    </span>
  );
}
