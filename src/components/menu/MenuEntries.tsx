/**
 * Menus as data.
 *
 * A terminal offers the same actions from its sidebar row, its pane header and
 * the terminal itself, so the menus are described once as plain entries (see
 * `actions.ts`) and rendered here. Entries are built when the menu opens, which
 * keeps every label — "Fullscreen" or "Exit fullscreen", which decks exist —
 * true at the moment you look at it.
 *
 * The same entries render as a right-click menu or as a menu-bar menu: each is
 * a kit of primitives with the same props, so a command is written once and
 * looks identical in both.
 */

import {
  createContext,
  useContext,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { LucideIcon } from "lucide-react";

import {
  ContextMenuCheckboxItem,
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
import {
  MenubarCheckboxItem,
  MenubarItem,
  MenubarLabel,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
} from "@/components/ui/menubar";

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
      kind: "check";
      label: string;
      checked: boolean;
      shortcut?: string;
      disabled?: boolean;
      onChange: (checked: boolean) => void;
    }
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
      options: { value: string; label: string; shortcut?: string }[];
      onChange: (value: string) => void;
    };

interface Kit {
  Item: ComponentType<{
    disabled?: boolean;
    variant?: "default" | "destructive";
    className?: string;
    onSelect?: (event: Event) => void;
    children?: ReactNode;
  }>;
  CheckboxItem: ComponentType<{
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    children?: ReactNode;
  }>;
  Label: ComponentType<{ children?: ReactNode }>;
  Separator: ComponentType<object>;
  Shortcut: ComponentType<{ children?: ReactNode }>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{ disabled?: boolean; children?: ReactNode }>;
  SubContent: ComponentType<{ children?: ReactNode }>;
  RadioGroup: ComponentType<{
    value?: string;
    onValueChange?: (value: string) => void;
    children?: ReactNode;
  }>;
  RadioItem: ComponentType<{ value: string; children?: ReactNode }>;
}

const CONTEXT_KIT: Kit = {
  Item: ContextMenuItem,
  CheckboxItem: ContextMenuCheckboxItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
};

const MENUBAR_KIT: Kit = {
  Item: MenubarItem,
  CheckboxItem: MenubarCheckboxItem,
  Label: MenubarLabel,
  Separator: MenubarSeparator,
  Shortcut: MenubarShortcut,
  Sub: MenubarSub,
  SubTrigger: MenubarSubTrigger,
  SubContent: MenubarSubContent,
  RadioGroup: MenubarRadioGroup,
  RadioItem: MenubarRadioItem,
};

const KitContext = createContext<Kit>(CONTEXT_KIT);

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

function Entries({
  entries,
}: {
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

export function ContextMenuEntries({
  entries,
}: {
  /** A function is only called once the menu is actually open. */
  entries: MenuEntry[] | (() => MenuEntry[]);
}) {
  return (
    <KitContext.Provider value={CONTEXT_KIT}>
      <Entries entries={entries} />
    </KitContext.Provider>
  );
}

export function MenubarEntries({
  entries,
}: {
  /** A function is only called once the menu is actually open. */
  entries: MenuEntry[] | (() => MenuEntry[]);
}) {
  return (
    <KitContext.Provider value={MENUBAR_KIT}>
      <Entries entries={entries} />
    </KitContext.Provider>
  );
}

function Entry({ entry }: { entry: MenuEntry }) {
  const kit = useContext(KitContext);
  switch (entry.kind) {
    case "separator":
      return <kit.Separator />;
    case "label":
      return <kit.Label>{entry.label}</kit.Label>;
    case "check":
      return (
        <kit.CheckboxItem
          checked={entry.checked}
          disabled={entry.disabled}
          onCheckedChange={entry.onChange}
        >
          <span className="truncate">{entry.label}</span>
          {entry.shortcut ? <kit.Shortcut>{entry.shortcut}</kit.Shortcut> : null}
        </kit.CheckboxItem>
      );
    case "radio":
      return (
        <kit.RadioGroup value={entry.value} onValueChange={entry.onChange}>
          {entry.options.map((option) => (
            <kit.RadioItem key={option.value} value={option.value}>
              <span className="truncate">{option.label}</span>
              {option.shortcut ? (
                <kit.Shortcut>{option.shortcut}</kit.Shortcut>
              ) : null}
            </kit.RadioItem>
          ))}
        </kit.RadioGroup>
      );
    case "sub": {
      const Icon = entry.icon;
      return (
        <kit.Sub>
          <kit.SubTrigger disabled={entry.disabled}>
            {Icon ? <Icon /> : null}
            {entry.label}
          </kit.SubTrigger>
          <kit.SubContent>
            <Entries entries={entry.entries} />
          </kit.SubContent>
        </kit.Sub>
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
  const kit = useContext(KitContext);
  const Icon = entry.icon;
  return (
    <kit.Item
      disabled={entry.disabled}
      variant={entry.destructive ? "destructive" : "default"}
      onSelect={entry.onSelect}
    >
      {Icon ? <Icon /> : null}
      <span className="truncate">{entry.label}</span>
      {entry.shortcut ? <kit.Shortcut>{entry.shortcut}</kit.Shortcut> : null}
    </kit.Item>
  );
}

function ConfirmItem({ entry }: { entry: MenuItemEntry }) {
  const kit = useContext(KitContext);
  const [armed, setArmed] = useState(false);
  const Icon = entry.icon;
  return (
    <kit.Item
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
    </kit.Item>
  );
}
