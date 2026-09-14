/**
 * The app shell: titlebar, sidebar, canvas, status bar.
 *
 * Four docked bands and one floating layer. The titlebar, sidebar and status bar
 * are square, flush to their edges and separated by hairlines; the canvas in the
 * middle is the only place anything floats, and everything that floats there is
 * rounded. That split is the entire visual system.
 *
 * Every deck of every project stays mounted for the whole session â€” only the
 * active one is visible. Hiding rather than unmounting is what lets you switch
 * away from six running agents and come back to them still running, scrollback
 * intact.
 *
 * The chrome stays compact. Anything the app wants to *say* lives in a menu or
 * a dialog; the space next to a terminal belongs to the terminal.
 */

import { useCallback, useEffect, useState } from "react";
import { open as openFolder } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { AgentSettingsDialog } from "@/components/AgentSettingsDialog";
import { Canvas } from "@/components/Canvas";
import { LaunchDialog } from "@/components/LaunchDialog";
import { Overview } from "@/components/Overview";
import { RestoreChrome } from "@/components/RestoreChrome";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { Titlebar, type TitlebarActions } from "@/components/Titlebar";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { statePath } from "@/lib/backend";
import { onHostLost } from "@/lib/invoke";
import { deckIndexOf, isKeelChord, MOVES } from "@/lib/keymap";
import { onPtyAgentExit, onPtyAgentStart, onPtyExit } from "@/lib/pty";
import { listPanes } from "@/lib/tree";
import { activeDeck, startAttentionTracking, useKeel } from "@/state/store";

export default function App() {
  const launching = useKeel((state) => state.launcher);
  const setLaunching = useKeel((state) => state.setLauncher);
  const [shortcuts, setShortcuts] = useState(false);
  const [overview, setOverview] = useState(false);
  const [sidebar, setSidebar] = useState(true);

  const ready = useKeel((state) => state.ready);
  const projects = useKeel((state) => state.projects);
  const agents = useKeel((state) => state.agents);
  const activeProjectId = useKeel((state) => state.activeProjectId);

  useEffect(() => {
    void useKeel.getState().init();
    const stopTracking = startAttentionTracking();
    const unlisten = onPtyExit((paneId) =>
      useKeel.getState().notePaneExit(paneId),
    );
    const unlistenAgent = onPtyAgentExit((paneId) =>
      useKeel.getState().releaseAgent(paneId),
    );
    const unlistenStart = onPtyAgentStart((paneId) => {
      void useKeel.getState().captureSession(paneId);
    });
    const stopHost = onHostLost(() => useKeel.getState().noteHostLost());
    // No browser context menu anywhere: "Reload" and "Inspect" have no business
    // in a desktop app. Every surface with something to offer opens its own.
    const blockNativeMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("contextmenu", blockNativeMenu);
    return () => {
      stopTracking();
      stopHost();
      window.removeEventListener("contextmenu", blockNativeMenu);
      void unlisten.then((stop) => stop());
      void unlistenAgent.then((stop) => stop());
      void unlistenStart.then((stop) => stop());
    };
  }, []);

  const pickFolder = useCallback(async () => {
    const picked = await openFolder({
      directory: true,
      multiple: false,
      title: "Add a project folder",
    });
    if (typeof picked === "string") useKeel.getState().addProject(picked);
  }, []);

  /**
   * Every shortcut, handled once, in the capture phase.
   *
   * xterm calls `stopPropagation()` on any chord it turns into an escape
   * sequence, so a bubble-phase listener never sees Alt+Shift+Arrow â€” the keys
   * simply vanished into the terminal. Capturing on `window` puts us ahead of
   * the terminal's own handler, and stopping the event here means the agent
   * never receives a keystroke that was meant for the window manager.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // F2 renames the focused terminal — but only when the keystroke comes
      // from a terminal (or from nowhere in particular). Sidebar rows and text
      // fields handle their own F2.
      if (
        event.key === "F2" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        const target = event.target as HTMLElement | null;
        const fromTerminal =
          !target ||
          target === document.body ||
          target.classList.contains("xterm-helper-textarea");
        const state = useKeel.getState();
        const project = state.projects.find(
          (item) => item.id === state.activeProjectId,
        );
        const focused = activeDeck(project)?.focused;
        if (fromTerminal && focused) {
          event.preventDefault();
          event.stopPropagation();
          state.startRename({ kind: "pane", id: focused, where: "pane" });
        }
        return;
      }

      if (!isKeelChord(event)) return;

      const state = useKeel.getState();
      const project = state.projects.find(
        (item) => item.id === state.activeProjectId,
      );

      const claim = () => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      };

      if (event.code === "KeyT") {
        claim();
        setLaunching(true);
        return;
      }
      if (!project) return;

      // Decks.
      if (event.code === "Space") {
        claim();
        setOverview((previous) => !previous);
        return;
      }
      if (event.code === "Enter") {
        claim();
        state.addDeck(project.id);
        return;
      }
      const deckIndex = deckIndexOf(event.code);
      if (deckIndex !== null) {
        claim();
        const target = project.decks[deckIndex];
        if (target) state.selectDeck(project.id, target.id);
        return;
      }

      if (event.code === "KeyE") {
        claim();
        state.balanceLayout(project.id);
        return;
      }
      if (event.code === "Tab") {
        claim();
        state.cyclePane(project.id, 1);
        return;
      }

      // Everything below acts on one pane.
      const focused = activeDeck(project)?.focused;
      if (!focused) return;

      // `code` is the physical key â€” unaffected by Shift or keyboard layout.
      const move = MOVES[event.code];
      if (move) {
        claim();
        state.movePane(project.id, focused, move);
        return;
      }

      switch (event.code) {
        case "KeyF":
          claim();
          state.toggleZoom(project.id, focused);
          break;
        case "KeyD":
          claim();
          state.duplicatePane(project.id, focused, "row");
          break;
        case "KeyS":
          claim();
          state.duplicatePane(project.id, focused, "column");
          break;
        case "KeyW":
          claim();
          state.closePane(project.id, focused);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const project = projects.find((item) => item.id === activeProjectId) ?? null;
  const deck = activeDeck(project);
  const hasPanes = listPanes(deck?.tree ?? null).length > 0;

  const focusedPane = deck?.focused ? (deck.panes[deck.focused] ?? null) : null;
  const statusCwd = focusedPane?.cwd ?? project?.path ?? null;
  const statusAgentName = focusedPane
    ? (agents.find((agent) => agent.id === focusedPane.agentId)?.name ??
      focusedPane.agentId ??
      "Shell")
    : "No focused pane";

  const actions: TitlebarActions = {
    addFolder: () => void pickFolder(),
    addTerminals: () => setLaunching(true),
    removeProject: () => project && useKeel.getState().removeProject(project.id),
    newDeck: () => project && useKeel.getState().addDeck(project.id),
    showOverview: () => setOverview(true),
    fullscreenPane: () =>
      project &&
      deck?.focused &&
      useKeel.getState().toggleZoom(project.id, deck.focused),
    balance: () => project && useKeel.getState().balanceLayout(project.id),
    nextPane: () => project && useKeel.getState().cyclePane(project.id, 1),
    toggleSidebar: () => setSidebar((previous) => !previous),
    showShortcuts: () => setShortcuts(true),
    openCatalogue: () => useKeel.getState().openAgentSettings(null),
    // Reveal rather than open: the interesting thing is the folder it sits in.
    openConfig: () => void statePath().then(revealItemInDir),
  };

  return (
    // No background of its own: the canvas wash lives on #root. Docked chrome
    // paints opaque over it; only floating overlays blur what sits behind them.
    <div className="flex h-full flex-col text-foreground">
      <Titlebar
        projectName={project?.name ?? null}
        projectPath={project?.path ?? null}
        deckName={project && project.decks.length > 1 ? (deck?.name ?? null) : null}
        sidebarVisible={sidebar}
        hasProject={project !== null}
        hasPanes={hasPanes}
        actions={actions}
      />

      <div className="flex min-h-0 flex-1">
        {sidebar ? (
          <Sidebar
            activeProjectId={activeProjectId}
            // Going somewhere from the sidebar has to lift the overview, which
            // is an opaque sheet over the canvas — otherwise the deck really
            // does change underneath and the click looks like it was ignored.
            onNavigate={() => setOverview(false)}
          />
        ) : null}

        {/* Half a gutter of padding, so the air around the outermost panes
            matches the air between two neighbours. */}
        <main className="relative min-h-0 min-w-0 flex-1 p-[6px]">
          <Canvas
            projects={projects}
            activeProjectId={activeProjectId}
            onAddTerminals={() => setLaunching(true)}
          />

          <RestoreChrome />

          {ready && projects.length === 0 ? (
            <div className="absolute inset-0 grid place-items-center">
              {/* The first screen anyone sees. It names the one thing to do and
                  gives the reason in a line, rather than explaining the app. */}
              <div className="w-[340px] text-center">
                <p className="text-[19px] leading-snug text-foreground">
                  Point Keel at a folder
                </p>
                <p className="mx-auto mt-2 max-w-[280px] text-[13px] leading-relaxed text-dim">
                  Every terminal you open belongs to a project, so Keel can bring
                  the whole arrangement back next time.
                </p>
                <Button className="mt-5" onClick={() => void pickFolder()}>
                  Add a folder
                </Button>
              </div>
            </div>
          ) : null}

          {overview && project ? (
            <Overview
              project={project}
              agents={agents}
              onClose={() => setOverview(false)}
            />
          ) : null}
        </main>
      </div>

      <StatusBar
        project={project}
        cwd={statusCwd}
        agentName={statusAgentName}
        // Same as the sidebar: the status bar stays clickable while the
        // overview covers the canvas, so anything that moves you has to lift it.
        onSelectDeck={(deckId) => {
          if (!project) return;
          useKeel.getState().selectDeck(project.id, deckId);
          setOverview(false);
        }}
        onAddDeck={() => {
          if (!project) return;
          useKeel.getState().addDeck(project.id);
          setOverview(false);
        }}
        onOverview={() => setOverview(true)}
      />

      <LaunchDialog
        open={launching}
        onOpenChange={setLaunching}
        project={project}
      />
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
      <AgentSettingsDialog />
      <Toaster />
    </div>
  );
}

