/**
 * The window's own chrome. Tauri draws no decorations, so this is it.
 *
 * One 38px band docked to the top edge. The menus are rounded targets inset in
 * the band rather than full-height slabs, which is what keeps the row reading as
 * a piece of glass with controls resting on it instead of as a menu bar bolted
 * to the top of the app.
 *
 * They are one `Menubar`, not three separate dropdowns. That is the difference
 * between a menu bar and three buttons that happen to sit in a row: once any of
 * them is open, moving the pointer across the other titles walks between them
 * and the arrow keys do the same. Three independent `DropdownMenu`s each own
 * their open state, so the click meant for the neighbour was spent dismissing
 * the menu you already had open.
 *
 * The window buttons stay square and full-height on the right: they belong to
 * the window frame, not to Keel, and matching what Windows draws there is worth
 * more than matching the rest of this file.
 */

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";

import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { cn } from "@/lib/utils";

export interface TitlebarActions {
  addFolder: () => void;
  addTerminals: () => void;
  removeProject: () => void;
  newDeck: () => void;
  showOverview: () => void;
  fullscreenPane: () => void;
  balance: () => void;
  nextPane: () => void;
  toggleSidebar: () => void;
  showShortcuts: () => void;
  openCatalogue: () => void;
  openConfig: () => void;
}

export interface TitlebarProps {
  /** Name of the folder currently in front, or `null` when there is none. */
  projectName: string | null;
  projectPath: string | null;
  /** Only set once a project has more than one deck. */
  deckName: string | null;
  sidebarVisible: boolean;
  hasProject: boolean;
  hasPanes: boolean;
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
  projectName,
  projectPath,
  deckName,
  sidebarVisible,
  hasProject,
  hasPanes,
  actions,
}: TitlebarProps) {
  const [maximized, setMaximized] = useState(false);

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
      className="k-glass relative z-30 flex h-[38px] shrink-0 items-stretch border-b border-line"
    >
      <div
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-0.5 pl-3.5"
      >
        <span
          data-tauri-drag-region
          className="flex items-center gap-2 pr-3 text-dim"
        >
          <KeelMark />
          <span className="text-[13px] font-medium tracking-[0.01em] text-dim">
            Keel
          </span>
        </span>

        <Menubar>
          <MenubarMenu>
            <MenubarTrigger>Project</MenubarTrigger>
            <MenubarContent className="w-72">
              <MenubarItem onSelect={actions.addFolder}>
                Add a folder…
              </MenubarItem>
              <MenubarItem
                disabled={!hasProject}
                onSelect={actions.addTerminals}
              >
                Add terminals…
                <MenubarShortcut>Alt+Shift+T</MenubarShortcut>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem disabled={!hasProject} onSelect={actions.newDeck}>
                New deck
                <MenubarShortcut>Alt+Shift+Enter</MenubarShortcut>
              </MenubarItem>
              <MenubarItem
                disabled={!hasProject}
                onSelect={actions.showOverview}
              >
                Overview of every deck
                <MenubarShortcut>Alt+Shift+Space</MenubarShortcut>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem
                variant="destructive"
                disabled={!hasProject}
                onSelect={actions.removeProject}
              >
                Remove this project
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>

          <MenubarMenu>
            <MenubarTrigger>View</MenubarTrigger>
            <MenubarContent className="w-72">
              <MenubarItem
                disabled={!hasPanes}
                onSelect={actions.fullscreenPane}
              >
                Fullscreen the focused pane
                <MenubarShortcut>Alt+Shift+F</MenubarShortcut>
              </MenubarItem>
              <MenubarItem disabled={!hasPanes} onSelect={actions.balance}>
                Even out every split
                <MenubarShortcut>Alt+Shift+E</MenubarShortcut>
              </MenubarItem>
              <MenubarItem disabled={!hasPanes} onSelect={actions.nextPane}>
                Focus the next pane
                <MenubarShortcut>Alt+Shift+Tab</MenubarShortcut>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarCheckboxItem
                checked={sidebarVisible}
                onSelect={(event) => {
                  event.preventDefault();
                  actions.toggleSidebar();
                }}
              >
                Sidebar
              </MenubarCheckboxItem>
            </MenubarContent>
          </MenubarMenu>

          <MenubarMenu>
            <MenubarTrigger>Help</MenubarTrigger>
            <MenubarContent className="w-72">
              <MenubarItem onSelect={actions.showShortcuts}>
                Keyboard shortcuts
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onSelect={actions.openCatalogue}>
                Agents & profiles…
              </MenubarItem>
              <MenubarItem onSelect={actions.openConfig}>
                Open the config folder…
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>
      </div>

      {/*
       * Where you are, centred and set in a recessed chip so it reads as a
       * readout rather than as a fourth menu. The deck is separated by a
       * hairline: it is a second field, not a continuation of the name.
       */}
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center justify-center px-4"
      >
        {projectName ? (
          <span
            data-tauri-drag-region
            className="flex min-w-0 items-center gap-2.5 rounded-[var(--keel-r-control)] bg-veil-2 px-2.5 py-1 shadow-[inset_0_1px_0_0_var(--keel-sheen)]"
            title={projectPath ?? undefined}
          >
            <span
              data-tauri-drag-region
              className="min-w-0 truncate text-[12px] text-dim"
            >
              {projectName}
            </span>
            {deckName ? (
              <>
                <span
                  aria-hidden
                  data-tauri-drag-region
                  className="h-3 w-px shrink-0 bg-line-strong"
                />
                <span
                  data-tauri-drag-region
                  className="min-w-0 truncate text-[12px] text-faint"
                >
                  {deckName}
                </span>
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      <div className="flex items-stretch">
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

function WindowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
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
