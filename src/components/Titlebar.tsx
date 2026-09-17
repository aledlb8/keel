/**
 * The window's own chrome. Tauri draws no decorations, so this is it.
 *
 * One 38px band docked to the top edge. The menus are rounded targets inset in
 * the band rather than full-height slabs, which is what keeps the row reading as
 * a piece of glass with controls resting on it instead of as a menu bar bolted
 * to the top of the app.
 *
 * Four menus, each answering one question: **Project** (what can I do to this
 * project), **Go** (where can I get to), **View** (how is it laid out) and
 * **Help**. They are one `Menubar` — once any is open, moving across the titles
 * walks between them and the arrow keys do the same; F10 opens it from the
 * keyboard. The menus themselves are data (`menu/actions.ts`) drawn with the
 * same entries as the right-click menus, so a command reads identically
 * wherever you reach for it.
 *
 * The window buttons stay square and full-height on the right: they belong to
 * the window frame, not to Keel, and matching what Windows draws there is worth
 * more than matching the rest of this file.
 */

import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";

import { MenubarEntries, type MenuEntry } from "@/components/menu/MenuEntries";
import {
  goBarMenu,
  helpBarMenu,
  projectBarMenu,
  viewBarMenu,
} from "@/components/menu/actions";
import {
  Menubar,
  MenubarContent,
  MenubarMenu,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { cn } from "@/lib/utils";
import { useKeel } from "@/state/store";

export interface TitlebarActions {
  addFolder: () => void;
  addWorkspace: () => void;
  addTerminals: () => void;
  removeProject: () => void;
  newDeck: () => void;
  selectDeck: (deckId: string) => void;
  showOverview: () => void;
  fullscreenPane: () => void;
  splitRight: () => void;
  splitDown: () => void;
  closePane: () => void;
  balance: () => void;
  nextPane: () => void;
  prevPane: () => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  showShortcuts: () => void;
  openCatalogue: () => void;
  openVpn: () => void;
  openConfig: () => void;
  goTo: () => void;
  filterSidebar: () => void;
  findInFiles: () => void;
  jumpToWaiting: () => void;
}

export interface TitlebarProps {
  /** Sits in the middle of the bar: where you are, and what needs you. */
  island: ReactNode;
  sidebarVisible: boolean;
  inspectorVisible: boolean;
  actions: TitlebarActions;
}

/**
 * The mark: a hull in section, cut off at the deck line. A keel is the spine a
 * boat is built out from, which is also what the app is — one structure holding
 * a lot of separate work upright. Drawn as a solid so it reads as a shape at
 * 14px rather than as a stray chevron.
 */
function KeelMark() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 13 13"
      fill="none"
      aria-hidden
      className="shrink-0"
    >
      <path
        d="M1.5 3.25H11.5V6.25C11.5 9.01142 9.26142 11.25 6.5 11.25C3.73858 11.25 1.5 9.01142 1.5 6.25V3.25Z"
        fill="currentColor"
        fillOpacity="0.9"
      />
      <path
        d="M6.5 3.25V11.25"
        stroke="var(--keel-void)"
        strokeOpacity="0.55"
        strokeWidth="1"
      />
    </svg>
  );
}

export function Titlebar({
  island,
  sidebarVisible,
  inspectorVisible,
  actions,
}: TitlebarProps) {
  const [maximized, setMaximized] = useState(false);
  const openMenu = useKeel((state) => state.menubar);
  const setOpenMenu = useKeel((state) => state.setMenubar);

  useEffect(() => {
    const window = getCurrentWindow();
    let stop: (() => void) | undefined;
    void window.isMaximized().then(setMaximized);
    void window
      .onResized(() => void window.isMaximized().then(setMaximized))
      .then((unlisten) => {
        stop = unlisten;
      });
    return () => stop?.();
  }, []);

  const appWindow = getCurrentWindow();

  return (
    <header
      data-tauri-drag-region
      className="k-glass relative z-30 grid h-[38px] shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-stretch border-b border-line"
    >
      <div
        data-tauri-drag-region
        className="relative z-10 flex min-w-0 items-center pl-3.5"
      >
        <span
          data-tauri-drag-region
          className="flex items-center gap-2 pr-2.5 text-dim"
        >
          <KeelMark />
          <span className="text-[13px] font-medium tracking-[0.01em] text-dim">
            Keel
          </span>
        </span>

        <span aria-hidden className="mr-1.5 h-4 w-px bg-line-strong" />

        <Menubar value={openMenu} onValueChange={setOpenMenu}>
          <BarMenu value="project" label="Project" entries={() => projectBarMenu(actions)} />
          <BarMenu value="go" label="Go" entries={() => goBarMenu(actions)} />
          <BarMenu
            value="view"
            label="View"
            entries={() => viewBarMenu(actions, sidebarVisible, inspectorVisible)}
          />
          <BarMenu value="help" label="Help" entries={() => helpBarMenu(actions)} />
        </Menubar>
      </div>

      {/*
       * The island: where you are, and whatever needs you. Equal 1fr columns
       * on either side keep it centred in the window, not in the leftover
       * space between the (wider) menus and the window buttons. The band
       * around it stays a drag region; the island itself is all buttons.
       */}
      <div
        data-tauri-drag-region
        className="flex min-w-0 items-center justify-center px-4"
      >
        {island}
      </div>

      <div
        data-tauri-drag-region
        className="relative z-10 flex min-w-0 items-stretch justify-end"
      >
        <WindowButton label="Minimize" onClick={() => void appWindow.minimize()}>
          <Minus className="size-3.5" />
        </WindowButton>
        <WindowButton
          label={maximized ? "Restore" : "Maximize"}
          onClick={() => void appWindow.toggleMaximize()}
        >
          <Square className="size-[11px]" />
        </WindowButton>
        <WindowButton
          label="Close"
          danger
          onClick={() => void appWindow.close()}
        >
          <X className="size-4" />
        </WindowButton>
      </div>
    </header>
  );
}

function BarMenu({
  value,
  label,
  entries,
}: {
  value: string;
  label: string;
  entries: () => MenuEntry[];
}) {
  return (
    <MenubarMenu value={value}>
      <MenubarTrigger>{label}</MenubarTrigger>
      <MenubarContent className="w-[292px]">
        <MenubarEntries entries={entries} />
      </MenubarContent>
    </MenubarMenu>
  );
}

function WindowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid w-[46px] place-items-center text-dim transition-colors",
        danger
          ? "hover:bg-[color:var(--keel-dead)] hover:text-[color:var(--keel-void)]"
          : "hover:bg-veil-2 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
