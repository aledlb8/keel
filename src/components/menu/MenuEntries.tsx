/**
 * Menus as data.
 *
 * A terminal offers the same actions from its sidebar row, its pane header and
 * the terminal itself, so the menus are described once as plain entries (see
 * `actions.ts`) and rendered here. Entries are built when the menu opens, which
 * keeps every label — "Fullscreen" or "Exit fullscreen", which decks exist —
 * true at the moment you look at it.
 */

import { useState } from "react";
import type { LucideIcon } from "lucide-react";

import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";

export interface MenuItemEntry {
  kind: "item";
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  disabled?: boolean;
  destructive?: boolean;
  /**
   * Ask again before running: the first click swaps the label to this text and
   * keeps the menu open, the second click does it.
   */
  confirm?: string;
  onSelect: () => void;
}

export type MenuEntry =
  | MenuItemEntry
  | { kind: "separator" }
  | { kind: "label"; label: string }
  | {
      kind: "sub";
      label: string;
      icon?: LucideIcon;
      disabled?: boolean;
      entries: MenuEntry[];
    }
  | {
      kind: "radio";
      value: string;
      options: { value: string; label: string }[];
      onChange: (value: string) => void;
    };

/** Drop separators that would sit at an edge or next to another separator. */
function tidy(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (
      entry.kind === "separator" &&
      (out.length === 0 || out[out.length - 1].kind === "separator")
    ) {
      continue;
    }
    out.push(entry);
  }
  while (out.length > 0 && out[out.length - 1].kind === "separator") out.pop();
  return out;
}

export function ContextMenuEntries({
  entries,
}: {
  /** A function is only called once the menu is actually open. */
  entries: MenuEntry[] | (() => MenuEntry[]);
}) {
  const list = tidy(typeof entries === "function" ? entries() : entries);
  return (
    <>
      {list.map((entry, index) => (
        <Entry key={index} entry={entry} />
      ))}
    </>
  );
}

function Entry({ entry }: { entry: MenuEntry }) {
  switch (entry.kind) {
    case "separator":
      return <ContextMenuSeparator />;
    case "label":
      return <ContextMenuLabel>{entry.label}</ContextMenuLabel>;
    case "radio":
      return (
        <ContextMenuRadioGroup value={entry.value} onValueChange={entry.onChange}>
          {entry.options.map((option) => (
            <ContextMenuRadioItem key={option.value} value={option.value}>
              <span className="truncate">{option.label}</span>
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
      );
    case "sub": {
      const Icon = entry.icon;
      return (
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={entry.disabled}>
            {Icon ? <Icon /> : null}
            {entry.label}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuEntries entries={entry.entries} />
          </ContextMenuSubContent>
        </ContextMenuSub>
      );
    }
    case "item":
      return entry.confirm ? (
        <ConfirmItem entry={entry} />
      ) : (
        <PlainItem entry={entry} />
      );
  }
}

function PlainItem({ entry }: { entry: MenuItemEntry }) {
  const Icon = entry.icon;
  return (
    <ContextMenuItem
      disabled={entry.disabled}
      variant={entry.destructive ? "destructive" : "default"}
      onSelect={entry.onSelect}
    >
      {Icon ? <Icon /> : null}
      <span className="truncate">{entry.label}</span>
      {entry.shortcut ? (
        <ContextMenuShortcut>{entry.shortcut}</ContextMenuShortcut>
      ) : null}
    </ContextMenuItem>
  );
}

function ConfirmItem({ entry }: { entry: MenuItemEntry }) {
  const [armed, setArmed] = useState(false);
  const Icon = entry.icon;
  return (
    <ContextMenuItem
      disabled={entry.disabled}
      variant="destructive"
      className={armed ? "bg-[color-mix(in_srgb,var(--keel-dead)_16%,transparent)]" : undefined}
      onSelect={(event) => {
        if (!armed) {
          event.preventDefault();
          setArmed(true);
          return;
        }
        entry.onSelect();
      }}
    >
      {Icon ? <Icon /> : null}
      <span className="truncate">{armed ? entry.confirm : entry.label}</span>
    </ContextMenuItem>
  );
}
