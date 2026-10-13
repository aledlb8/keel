/**
 * A screen: one deck in a window of its own, for a second monitor or a tenth.
 *
 * It holds no state of its own. The store here mirrors the main window's (see
 * `src/lib/mirror.ts`), and everything done here — typing aside, which goes
 * straight to the terminal — runs in the main window. What a screen draws is
 * the bare minimum to work in the deck: a slim bar with the deck's name and a
 * way to switch it, what is waiting on you, the way back to the main window,
 * and the terminals.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, ChevronDown, Minus, PanelLeftClose, Square, X } from "lucide-react";

import { Canvas } from "@/components/Canvas";
import { focusTerminal } from "@/components/Island";
import { LaunchDialog } from "@/components/LaunchDialog";
import { KeelMark, WindowButton } from "@/components/Titlebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import { isBrowserChromeKey } from "@/lib/appShortcuts";
import { waitingPanes } from "@/lib/island";
import { bindingFor, isEditableTarget, matchesBinding, matchShortcut } from "@/lib/keymap";
import { screenLabel, screenOfDeck } from "@/lib/screens";
import { startWindowFocusTracking } from "@/lib/windowFocus";
import { onFocusPaneRequest } from "@/lib/windows";
import { cycleEditorTab } from "@/lib/editorTabs";
import { useKeel } from "@/state/store";
import { useWorkspace } from "@/state/workspace";

/** The terminal that has the keyboard in this window, if one does. */
function focusedTerminal(): string | null {
  return (
    document.activeElement?.closest("[data-terminal-pane]")?.getAttribute("data-terminal-pane") ??
    null
  );
}

export default function ScreenApp({ screenId }: { screenId: string }) {
  const label = screenLabel(screenId);
  const screen = useKeel((state) => state.screens.find((item) => item.id === screenId) ?? null);
  const projects = useKeel((state) => state.projects);
  const launching = useKeel((state) => state.launcher);
  const setLaunching = useKeel((state) => state.setLauncher);
  // Menus and hints print the active chords.
  useKeel((state) => state.keybindings);

  const project = projects.find((item) => item.id === screen?.projectId) ?? null;
  const deck = project?.decks.find((item) => item.id === screen?.deckId) ?? null;

  // Which terminal has the keyboard here, for "is anyone watching it".
  useEffect(() => {
    const report = () =>
      useKeel.getState().noteWindowFocus(label, document.hasFocus(), focusedTerminal());
    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    document.addEventListener("focusin", report);
    const stopFade = startWindowFocusTracking();
    const blockNativeMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("contextmenu", blockNativeMenu);
    const stopFocus = onFocusPaneRequest((paneId) => focusTerminal(paneId));
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      document.removeEventListener("focusin", report);
      window.removeEventListener("contextmenu", blockNativeMenu);
      stopFade();
      void stopFocus.then((stop) => stop());
    };
  }, [label]);

  useEffect(() => {
    if (project && deck) getCurrentWindow().setTitle(`${deck.name} · ${project.name} — Keel`).catch(() => {});
  }, [project, deck]);

  useScreenShortcuts(label, screenId);

  const owns = useCallback((deckId: string) => deckId === screen?.deckId, [screen?.deckId]);

  return (
    <div className="flex h-full flex-col text-foreground">
      <ScreenBar screenId={screenId} />
      <main className="relative flex min-h-0 flex-1 p-[6px]">
        <div className="relative min-h-0 min-w-0 flex-1">
          <Canvas
            projects={projects}
            shown={project && deck ? { projectId: project.id, deckId: deck.id } : null}
            owns={owns}
            onAddTerminals={() => setLaunching(true)}
          />
        </div>
      </main>
      <LaunchDialog
        open={launching}
        onOpenChange={setLaunching}
        project={project}
        deckId={deck?.id}
      />
      <Toaster />
    </div>
  );
}

function ScreenBar({ screenId }: { screenId: string }) {
  const screens = useKeel((state) => state.screens);
  const projects = useKeel((state) => state.projects);
  const status = useKeel((state) => state.status);
  const doneAt = useKeel((state) => state.doneAt);
  const [maximized, setMaximized] = useState(false);
  const appWindow = getCurrentWindow();

  useEffect(() => {
    let stop: (() => void) | undefined;
    void appWindow.isMaximized().then(setMaximized);
    void appWindow
      .onResized(() => void appWindow.isMaximized().then(setMaximized))
      .then((unlisten) => {
        stop = unlisten;
      });
    return () => stop?.();
  }, [appWindow]);

  const screen = screens.find((item) => item.id === screenId) ?? null;
  const project = projects.find((item) => item.id === screen?.projectId) ?? null;
  const deck = project?.decks.find((item) => item.id === screen?.deckId) ?? null;
  const waiting = useMemo(
    () => waitingPanes(projects, status, doneAt, deck?.focused ?? null),
    [projects, status, doneAt, deck?.focused],
  );

  const keel = useKeel.getState;
  const close = () => keel().closeScreen(screenId);

  return (
    <header
      data-tauri-drag-region
      className="k-glass relative z-30 grid h-[38px] shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-stretch border-b border-line"
    >
      <div data-tauri-drag-region className="relative z-10 flex min-w-0 items-center gap-2 pl-3.5">
        <span data-tauri-drag-region className="text-dim">
          <KeelMark />
        </span>
        {project && deck ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex min-w-0 items-center gap-1.5 rounded-control px-2 py-1 text-row hover:bg-veil-2"
              title="Show another deck in this window"
            >
              <span className="truncate font-medium text-foreground">{deck.name}</span>
              <span className="truncate text-dim">{project.name}</span>
              <ChevronDown className="size-3.5 shrink-0 text-faint" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[260px]">
              {project.decks.map((item) => {
                const elsewhere = screenOfDeck(screens, item.id);
                const here = item.id === deck.id;
                return (
                  <DropdownMenuItem
                    key={item.id}
                    onSelect={() => !here && keel().showOnScreen(screenId, item.id)}
                  >
                    <span className="flex size-4 items-center justify-center">
                      {here ? <Check className="size-3.5" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {elsewhere && !here ? (
                      <span className="text-small text-faint">in another window</span>
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => keel().bringDeckHome(deck.id)}>
                <PanelLeftClose className="size-4" />
                Back to the main window
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <div data-tauri-drag-region className="flex min-w-0 items-center justify-center px-4">
        {waiting.length > 0 ? (
          <button
            type="button"
            className="k-tag flex items-center gap-1.5"
            title="Go to the agent that has waited longest"
            onClick={() => keel().jumpToPane(waiting[0]!.paneId)}
          >
            <span className="size-1.5 rounded-full bg-[color:var(--keel-done)]" />
            {waiting.length === 1
              ? `${waiting[0]!.title} is waiting`
              : `${waiting.length} agents waiting`}
          </button>
        ) : null}
      </div>

      <div data-tauri-drag-region className="relative z-10 flex min-w-0 items-stretch justify-end">
        {deck ? (
          <WindowButton label="Back to the main window" onClick={() => keel().bringDeckHome(deck.id)}>
            <PanelLeftClose className="size-3.5" />
          </WindowButton>
        ) : null}
        <WindowButton label="Minimize" onClick={() => void appWindow.minimize()}>
          <Minus className="size-3.5" />
        </WindowButton>
        <WindowButton
          label={maximized ? "Restore" : "Maximize"}
          onClick={() => void appWindow.toggleMaximize()}
        >
          <Square className="size-[11px]" />
        </WindowButton>
        <WindowButton label="Close" danger onClick={close}>
          <X className="size-4" />
        </WindowButton>
      </div>
    </header>
  );
}

/** The shortcuts that mean something in a window with one deck in it. */
function useScreenShortcuts(label: string, screenId: string) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const focus = document.activeElement;
      if (focus instanceof HTMLElement && focus.closest("[data-shortcut-recorder]")) return;
      if (isBrowserChromeKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      if (event.repeat) return;
      const state = useKeel.getState();
      if (state.launcher || document.querySelector("[role='dialog']")) return;

      const screen = state.screens.find((item) => item.id === screenId);
      const project = state.projects.find((item) => item.id === screen?.projectId);
      const deck = project?.decks.find((item) => item.id === screen?.deckId);
      if (!screen || !project || !deck) return;

      if (matchesBinding(event, bindingFor("rename"))) {
        const target = event.target as HTMLElement | null;
        const fromTerminal =
          !target || target === document.body || target.classList.contains("xterm-helper-textarea");
        if (fromTerminal && deck.focused) {
          event.preventDefault();
          event.stopPropagation();
          state.startRename({ kind: "pane", id: deck.focused, where: "pane" });
        }
        return;
      }
      if (isEditableTarget(event.target)) return;

      const matched = matchShortcut(event);
      if (!matched) return;
      const claim = () => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      };
      const focused = deck.focused;

      switch (matched.action) {
        case "addTerminals":
          claim();
          state.setLauncher(true);
          return;
        case "nextWaiting":
          claim();
          state.jumpToNextWaiting();
          return;
        case "nextPane":
        case "prevPane":
          claim();
          state.cyclePane(project.id, matched.action === "nextPane" ? 1 : -1, deck.id);
          return;
        case "balance":
          claim();
          state.balanceLayout(project.id, deck.id);
          return;
        case "jumpDeck": {
          claim();
          const target = project.decks[matched.index];
          if (target) state.showOnScreen(screenId, target.id);
          return;
        }
        case "focusWindow":
          claim();
          state.focusToward(label, matched.direction);
          return;
        case "sendDeck":
          claim();
          state.sendDeckToward(label, deck.id, matched.direction);
          return;
        default:
          break;
      }

      if (!focused) return;
      switch (matched.action) {
        case "movePane":
          claim();
          state.movePane(project.id, focused, matched.direction);
          return;
        case "fullscreen":
          claim();
          state.toggleZoom(project.id, focused);
          return;
        case "splitRight":
        case "splitDown":
          claim();
          state.duplicatePane(project.id, focused, matched.action === "splitRight" ? "row" : "column");
          return;
        case "closePane":
          claim();
          useWorkspace.getState().closePaneSafely(project.id, focused);
          return;
        case "nextTab":
        case "prevTab": {
          const pane = deck.panes[focused];
          if (!pane?.editor) return;
          claim();
          cycleEditorTab(project.id, pane, matched.action === "nextTab" ? 1 : -1);
          return;
        }
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [label, screenId]);
}
