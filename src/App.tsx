/**
 * The app shell: titlebar, two docks, the canvas, status bar.
 *
 * Two bands and a floor. The titlebar and status bar are square, flush to the
 * window edges and separated by hairlines. Everything between them floats on
 * the ground as a rounded object — the projects dock on the left, the files and
 * git dock on the right, every terminal, and the editor when a file is open —
 * and every one of them sits half a gutter inside its slot, so the air between
 * any two neighbours is the same 12px whatever they are.
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
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { AgentSettingsDialog } from "@/components/AgentSettingsDialog";
import { Canvas } from "@/components/Canvas";
import { focusTerminal, Island } from "@/components/Island";
import { LaunchDialog } from "@/components/LaunchDialog";
import { Overview } from "@/components/Overview";
import { RestoreChrome } from "@/components/RestoreChrome";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { Inspector } from "@/components/inspector/Inspector";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { TitleTips } from "@/components/TitleTips";
import { Titlebar, type TitlebarActions } from "@/components/Titlebar";
import { VpnDialog } from "@/components/VpnDialog";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { pickProjectFolder, statePath } from "@/lib/backend";
import { startCloseGuard } from "@/lib/closeGuard";
import { onHostLost } from "@/lib/invoke";
import {
  bindingFor,
  isEditableTarget,
  matchesBinding,
  matchShortcut,
} from "@/lib/keymap";
import { onPtyAgentExit, onPtyAgentStart, onPtyExit } from "@/lib/pty";
import { pruneRecent } from "@/lib/recentFiles";
import {
  isWatching,
  onWorkspaceChanged,
  workspaceUnwatch,
  workspaceWatch,
} from "@/lib/workspaceWatch";
import {
  activeDeck,
  deckOfPane,
  startAttentionTracking,
  useKeel,
} from "@/state/store";
import { useWorkspace } from "@/state/workspace";

const SIDEBAR_KEY = "keel.sidebar";
const INSPECTOR_KEY = "keel.inspector";

export default function App() {
  const launching = useKeel((state) => state.launcher);
  const setLaunching = useKeel((state) => state.setLauncher);
  const [shortcuts, setShortcuts] = useState(false);
  const [overview, setOverview] = useState(false);
  // Expanded or folded to the rail. A view preference, so it lives with the
  // window rather than in the saved projects.
  const [sidebar, setSidebar] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== "collapsed";
    } catch {
      return true;
    }
  });
  // Files and git start folded: the terminals get the room until you ask.
  const [inspector, setInspector] = useState(() => {
    try {
      return localStorage.getItem(INSPECTOR_KEY) === "expanded";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebar ? "expanded" : "collapsed");
    } catch {
      // Storage unavailable: the choice just lasts for this session.
    }
  }, [sidebar]);

  useEffect(() => {
    try {
      localStorage.setItem(INSPECTOR_KEY, inspector ? "expanded" : "collapsed");
    } catch {
      // Storage unavailable: the choice just lasts for this session.
    }
  }, [inspector]);

  const ready = useKeel((state) => state.ready);
  const vpnConnected = useKeel((state) => state.vpn.phase === "connected");
  const projects = useKeel((state) => state.projects);
  const agents = useKeel((state) => state.agents);
  const activeProjectId = useKeel((state) => state.activeProjectId);
  const projectPaths = [...new Set(projects.map((item) => item.path))]
    .filter(Boolean)
    .sort()
    .join("\n");
  // Menus, tooltips and hints print the active chords. Re-render the shell when
  // they change so every label follows at once.
  useKeel((state) => state.keybindings);

  useEffect(() => {
    if (!vpnConnected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      await useKeel.getState().refreshVpn();
      if (!cancelled) timer = setTimeout(refresh, 3_000);
    };
    // The native monitor can close a failed tunnel independently of the UI.
    // Schedule after each response so a slow host never accumulates polls.
    timer = setTimeout(refresh, 3_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [vpnConnected]);

  useEffect(() => {
    const paths = projectPaths ? projectPaths.split("\n") : [];
    let cancelled = false;
    const started: string[] = [];

    void (async () => {
      for (const path of paths) {
        try {
          await workspaceWatch(path);
          if (cancelled) {
            void workspaceUnwatch(path).catch(() => {});
            continue;
          }
          started.push(path);
        } catch {
          /* Inspector keeps the 4s poll for a folder the watcher could not cover. */
        }
      }
      if (!cancelled) {
        useWorkspace.getState().setFsWatch(isWatching(useWorkspace.getState().root));
      }
    })();

    return () => {
      cancelled = true;
      useWorkspace.getState().setFsWatch(false);
      for (const path of started) void workspaceUnwatch(path).catch(() => {});
    };
  }, [projectPaths]);

  useEffect(() => {
    const project = useKeel
      .getState()
      .projects.find((item) => item.id === activeProjectId);
    useWorkspace.getState().setFsWatch(isWatching(project?.path ?? null));
  }, [activeProjectId, projectPaths]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let alive = true;
    void onWorkspaceChanged((event) => {
      useWorkspace.getState().applyFsChange(event.root, event.rels, event.git);
    }).then((unlisten) => {
      if (!alive) unlisten();
      else stop = unlisten;
    });
    const expire = window.setInterval(() => {
      pruneRecent();
      useWorkspace.getState().bumpRecent();
    }, 30_000);
    return () => {
      alive = false;
      stop?.();
      window.clearInterval(expire);
    };
  }, []);

  useEffect(() => {
    void useKeel.getState().init();
    const stopTracking = startAttentionTracking();
    const unlisten = onPtyExit((paneId, generation) => {
      useKeel.getState().notePaneExit(paneId, generation);
    });
    const unlistenAgent = onPtyAgentExit((paneId, generation) => {
      useKeel.getState().releaseAgent(paneId, generation);
    });
    const unlistenStart = onPtyAgentStart((paneId, generation) => {
      void useKeel.getState().captureSession(paneId, generation);
    });
    const stopHost = onHostLost(() => useKeel.getState().noteHostLost());
    const stopClose = startCloseGuard();
    // No browser context menu anywhere: "Reload" and "Inspect" have no business
    // in a desktop app. Every surface with something to offer opens its own.
    const blockNativeMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("contextmenu", blockNativeMenu);
    return () => {
      stopTracking();
      stopHost();
      stopClose();
      window.removeEventListener("contextmenu", blockNativeMenu);
      void unlisten.then((stop) => stop());
      void unlistenAgent.then((stop) => stop());
      void unlistenStart.then((stop) => stop());
    };
  }, []);

  const pickFolder = useCallback(async () => {
    const picked = await pickProjectFolder();
    if (picked) useKeel.getState().addProject(picked);
  }, []);

  /**
   * Every shortcut, handled once, in the capture phase.
   *
   * xterm calls `stopPropagation()` on any chord it turns into an escape
   * sequence, so a bubble-phase listener never sees Ctrl+Shift+Arrow — the keys
   * simply vanished into the terminal. Capturing on `window` puts us ahead of
   * the terminal's own handler, and stopping the event here means the agent
   * never receives a keystroke that was meant for the window manager.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The shortcuts editor is listening for a new chord. Whatever you press
      // is the thing being recorded, not something for the app to do.
      const focus = document.activeElement;
      if (focus instanceof HTMLElement && focus.closest("[data-shortcut-recorder]")) {
        return;
      }

      // Rename (F2 unless you changed it) renames the focused terminal — but
      // only when the keystroke comes from a terminal (or from nowhere in
      // particular). Sidebar rows and text fields handle their own.
      if (matchesBinding(event, bindingFor("rename"))) {
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

      const editorNode =
        event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
      const editorPane = editorNode?.closest<HTMLElement>("[data-editor-pane]");

      // Typing in an editor, the close chord closes the tab rather than the pane.
      if (editorPane && matchesBinding(event, bindingFor("closePane"))) {
        const paneId = editorPane.dataset.editorPane ?? "";
        const state = useKeel.getState();
        const project = state.projects.find(
          (item) => item.id === state.activeProjectId,
        );
        const active = project
          ? deckOfPane(project, paneId)?.panes[paneId]?.editor?.active
          : null;
        if (project && active) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          useWorkspace.getState().closeTab(project.id, paneId, active);
        }
        return;
      }

      // Find in files is a window action even when the caret is in an editor
      // or a field. Ctrl+F stays with the editor; this chord is ours.
      if (isEditableTarget(event.target) && !matchesBinding(event, bindingFor("findInFiles"))) {
        return;
      }

      const matched = matchShortcut(event);
      if (!matched) return;

      const state = useKeel.getState();
      const project = state.projects.find(
        (item) => item.id === state.activeProjectId,
      );

      const claim = () => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      };

      switch (matched.action) {
        case "addTerminals":
          claim();
          setLaunching(true);
          return;
        case "goTo":
          claim();
          state.setSwitcher(!state.switcher);
          return;
        case "nextWaiting": {
          claim();
          const paneId = state.jumpToNextWaiting();
          if (paneId) {
            setOverview(false);
            focusTerminal(paneId);
          }
          return;
        }
        case "toggleSidebar":
          claim();
          setSidebar((previous) => !previous);
          return;
        case "toggleInspector":
          claim();
          setInspector((previous) => !previous);
          return;
        case "findInFiles":
          claim();
          setInspector(true);
          useWorkspace.getState().setTab("search");
          requestAnimationFrame(() => {
            document.querySelector<HTMLInputElement>("[data-grep-query]")?.focus();
          });
          return;
        case "menuBar":
          claim();
          state.setMenubar(state.menubar ? "" : "project");
          return;
        default:
          break;
      }

      if (!project) return;

      switch (matched.action) {
        case "overview":
          claim();
          setOverview((previous) => !previous);
          return;
        case "newDeck":
          claim();
          state.addDeck(project.id);
          return;
        case "jumpDeck": {
          claim();
          const target = project.decks[matched.index];
          if (target) state.selectDeck(project.id, target.id);
          return;
        }
        case "balance":
          claim();
          state.balanceLayout(project.id);
          return;
        case "nextPane":
          claim();
          state.cyclePane(project.id, 1);
          return;
        case "prevPane":
          claim();
          state.cyclePane(project.id, -1);
          return;
        default:
          break;
      }

      const focused = activeDeck(project)?.focused;
      if (!focused) return;

      switch (matched.action) {
        case "movePane":
          claim();
          state.movePane(project.id, focused, matched.direction);
          break;
        case "fullscreen":
          claim();
          state.toggleZoom(project.id, focused);
          break;
        case "splitRight":
          claim();
          state.duplicatePane(project.id, focused, "row");
          break;
        case "splitDown":
          claim();
          state.duplicatePane(project.id, focused, "column");
          break;
        case "closePane":
          claim();
          useWorkspace.getState().closePaneSafely(project.id, focused);
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

  const focusedPane = deck?.focused ? (deck.panes[deck.focused] ?? null) : null;
  const statusCwd = focusedPane?.cwd ?? project?.path ?? null;

  const actions: TitlebarActions = {
    addFolder: () => void pickFolder(),
    addWorkspace: () => useKeel.getState().addWorkspace(),
    addTerminals: () => setLaunching(true),
    removeProject: () =>
      project && useWorkspace.getState().removeProjectSafely(project.id),
    newDeck: () => project && useKeel.getState().addDeck(project.id),
    showOverview: () => setOverview(true),
    fullscreenPane: () =>
      project &&
      deck?.focused &&
      useKeel.getState().toggleZoom(project.id, deck.focused),
    balance: () => project && useKeel.getState().balanceLayout(project.id),
    nextPane: () => project && useKeel.getState().cyclePane(project.id, 1),
    prevPane: () => project && useKeel.getState().cyclePane(project.id, -1),
    toggleSidebar: () => setSidebar((previous) => !previous),
    toggleInspector: () => setInspector((previous) => !previous),
    showShortcuts: () => setShortcuts(true),
    openCatalogue: () => useKeel.getState().openAgentSettings(null),
    openVpn: () => useKeel.getState().openVpnSettings(),
    // Reveal rather than open: the interesting thing is the folder it sits in.
    openConfig: () => void statePath().then(revealItemInDir),
    selectDeck: (deckId) => {
      if (!project) return;
      useKeel.getState().selectDeck(project.id, deckId);
      setOverview(false);
    },
    splitRight: () =>
      project &&
      deck?.focused &&
      useKeel.getState().duplicatePane(project.id, deck.focused, "row"),
    splitDown: () =>
      project &&
      deck?.focused &&
      useKeel.getState().duplicatePane(project.id, deck.focused, "column"),
    closePane: () =>
      project &&
      deck?.focused &&
      useWorkspace.getState().closePaneSafely(project.id, deck.focused),
    goTo: () => useKeel.getState().setSwitcher(true),
    findInFiles: () => {
      setInspector(true);
      useWorkspace.getState().setTab("search");
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>("[data-grep-query]")?.focus();
      });
    },
    jumpToWaiting: () => {
      const paneId = useKeel.getState().jumpToNextWaiting();
      if (!paneId) return;
      setOverview(false);
      focusTerminal(paneId);
    },
  };

  return (
    // No background of its own: the canvas wash lives on #root. Docked chrome
    // paints opaque over it; only floating overlays blur what sits behind them.
    <div className="flex h-full flex-col text-foreground">
      <Titlebar
        island={
          <Island actions={actions} onNavigate={() => setOverview(false)} />
        }
        sidebarVisible={sidebar}
        inspectorVisible={inspector}
        actions={actions}
      />

      {/* Half a gutter of padding here, and half again inside every dock,
          pane and the editor, so all the air in the middle is one gutter. */}
      <div className="flex min-h-0 flex-1 p-[6px]">
        <Sidebar
          activeProjectId={activeProjectId}
          collapsed={!sidebar}
          onToggleCollapsed={() => setSidebar((previous) => !previous)}
          // Going somewhere from the sidebar has to lift the overview, which
          // is an opaque sheet over the canvas — otherwise the deck really
          // does change underneath and the click looks like it was ignored.
          onNavigate={() => setOverview(false)}
        />

        {/* Terminals and editors alike are panes on the canvas. Opening a file
            adds an editor pane to the deck, and the layout reflows around it. */}
        <main className="relative flex min-h-0 min-w-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1">
            <Canvas
              projects={projects}
              activeProjectId={activeProjectId}
              onAddTerminals={() => setLaunching(true)}
            />

            <RestoreChrome />

            {ready && projects.length === 0 ? (
              <div className="absolute inset-0 grid place-items-center">
                {/* The first screen anyone sees. It names the one thing to do
                    and gives the reason in a line, rather than explaining. */}
                <div className="w-[340px] text-center">
                  <p className="text-[19px] leading-snug text-foreground">
                    Point Keel at a folder
                  </p>
                  <p className="mx-auto mt-2 max-w-[280px] text-[13px] leading-relaxed text-dim">
                    Every terminal you open belongs to a project, so Keel can
                    bring the whole arrangement back next time.
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
          </div>
        </main>

        <Inspector
          collapsed={!inspector}
          onToggleCollapsed={() => setInspector((previous) => !previous)}
          projectPath={project?.path ?? null}
          projectName={project?.name ?? null}
        />
      </div>

      <TitleTips />

      <StatusBar
        project={project}
        cwd={statusCwd}
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
      <VpnDialog />
      <Toaster />
    </div>
  );
}

