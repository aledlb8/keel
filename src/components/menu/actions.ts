/**
 * Every right-click menu in the app, as data.
 *
 * Each builder reads the store at the moment the menu opens, so the entries
 * describe what is true right now. Actions call the store directly — a menu is
 * just another way of reaching the same operations as the keyboard and buttons.
 */

import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BellDot,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardPaste,
  Copy,
  Eraser,
  Columns3,
  FolderCog,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Folders,
  FolderOutput,
  FileSearch,
  Keyboard,
  Layers,
  LayoutGrid,
  ListFilter,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Settings2,
  ShieldCheck,
  SplitSquareHorizontal,
  SplitSquareVertical,
  TextSelect,
  Trash2,
  Ungroup,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";

import type { MenuEntry } from "@/components/menu/MenuEntries";
import { terminalCommands } from "@/components/TerminalSurface";
import type { TitlebarActions } from "@/components/Titlebar";
import { WorkspaceGlyph } from "@/components/WorkspaceMark";
import { pickProjectFolder as pickRegisteredFolder } from "@/lib/backend";
import { lookingAt, waitingPanes } from "@/lib/island";
import { deckShortcutKeys, shortcutKeys } from "@/lib/keymap";
import { listPanes } from "@/lib/tree";
import { repairSidebar, workspaceOf } from "@/lib/workspaces";
import {
  activeDeck,
  deckOfPane,
  useKeel,
  type RenameTarget,
} from "@/state/store";
import { useWorkspace } from "@/state/workspace";

const DEFAULT_PROFILE = "__default__";

const REVEAL_LABEL = /Windows/i.test(navigator.userAgent)
  ? "Show in Explorer"
  : /Mac/i.test(navigator.userAgent)
    ? "Reveal in Finder"
    : "Open containing folder";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function copyText(text: string) {
  void navigator.clipboard.writeText(text).catch(() => {});
}

export async function pickProjectFolder(workspaceId?: string) {
  const picked = await pickRegisteredFolder();
  if (picked) {
    useKeel.getState().addProject(picked, undefined, workspaceId);
  }
}

// ---- The menu bar ------------------------------------------------------------
//
// Four menus, each a question you might be asking: what can I do to this
// project, where can I go, how is it laid out, and where do I find help. Every
// entry is built when its menu opens, so what is disabled and which deck is
// ticked describe the window as it is right now.

/** What the menu bar acts on: the project in front, its deck, its focused pane. */
function inFront() {
  const state = useKeel.getState();
  const project =
    state.projects.find((item) => item.id === state.activeProjectId) ?? null;
  const deck = activeDeck(project);
  const focused =
    deck?.focused && listPanes(deck.tree).includes(deck.focused)
      ? deck.focused
      : null;
  return { state, project, deck, focused };
}

export function projectBarMenu(actions: TitlebarActions): MenuEntry[] {
  const { state, project } = inFront();
  const terminals = project
    ? project.decks.reduce((sum, deck) => sum + listPanes(deck.tree).length, 0)
    : 0;

  return [
    ...(project ? [{ kind: "label", label: project.name } as const] : []),
    {
      kind: "item",
      label: "Add terminals…",
      icon: Plus,
      shortcut: shortcutKeys("addTerminals"),
      disabled: !project,
      onSelect: actions.addTerminals,
    },
    {
      kind: "item",
      label: "New deck",
      icon: Layers,
      shortcut: shortcutKeys("newDeck"),
      disabled: !project,
      onSelect: actions.newDeck,
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Add a folder…",
      icon: FolderPlus,
      onSelect: actions.addFolder,
    },
    {
      kind: "item",
      label: "New workspace",
      icon: WorkspaceGlyph,
      onSelect: actions.addWorkspace,
    },
    {
      kind: "sub",
      label: "Switch project",
      icon: Folders,
      disabled: state.projects.length < 2,
      entries: [
        {
          kind: "radio",
          value: state.activeProjectId ?? "",
          options: state.projects.map((item) => {
            const group = workspaceOf(state.workspaces, item.id);
            return {
              value: item.id,
              label: group ? `${group.name} / ${item.name}` : item.name,
            };
          }),
          onChange: (projectId) => state.selectProject(projectId),
        },
      ],
    },
    { kind: "separator" },
    {
      kind: "item",
      label: REVEAL_LABEL,
      icon: FolderOpen,
      disabled: !project,
      onSelect: () => {
        if (project) void revealItemInDir(project.path);
      },
    },
    {
      kind: "item",
      label: "Copy path",
      icon: Copy,
      disabled: !project,
      onSelect: () => {
        if (project) copyText(project.path);
      },
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Remove from Keel",
      icon: Trash2,
      destructive: true,
      disabled: !project,
      confirm:
        terminals > 0
          ? `Close ${plural(terminals, "terminal")} and remove`
          : "Click again to remove",
      onSelect: actions.removeProject,
    },
  ];
}

export function goBarMenu(actions: TitlebarActions): MenuEntry[] {
  const { state, project, focused } = inFront();
  const waiting = waitingPanes(
    state.projects,
    state.status,
    state.doneAt,
    lookingAt(state.projects, state.activeProjectId),
  ).length;
  const decks = project && project.decks.length > 1 ? project.decks : [];

  return [
    {
      kind: "item",
      label: "Go to…",
      icon: Search,
      shortcut: shortcutKeys("goTo"),
      onSelect: actions.goTo,
    },
    {
      kind: "item",
      label: "Filter the sidebar",
      icon: ListFilter,
      shortcut: shortcutKeys("filterSidebar"),
      onSelect: actions.filterSidebar,
    },
    {
      kind: "item",
      label: "Find in files",
      icon: FileSearch,
      shortcut: shortcutKeys("findInFiles"),
      onSelect: actions.findInFiles,
    },
    {
      kind: "item",
      label:
        waiting > 0
          ? `Next waiting agent (${waiting})`
          : "Next waiting agent",
      icon: BellDot,
      shortcut: shortcutKeys("nextWaiting"),
      onSelect: actions.jumpToWaiting,
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Next pane",
      icon: ArrowRight,
      shortcut: shortcutKeys("nextPane"),
      disabled: !focused,
      onSelect: actions.nextPane,
    },
    {
      kind: "item",
      label: "Previous pane",
      icon: ArrowLeft,
      shortcut: shortcutKeys("prevPane"),
      disabled: !focused,
      onSelect: actions.prevPane,
    },
    ...(project && decks.length > 0
      ? ([
          { kind: "separator" },
          { kind: "label", label: "Decks" },
          {
            kind: "radio",
            value: project.activeDeckId ?? "",
            options: decks.map((deck, index) => ({
              value: deck.id,
              label: deck.name,
              shortcut: deckShortcutKeys(index),
            })),
            onChange: actions.selectDeck,
          },
        ] satisfies MenuEntry[])
      : []),
    { kind: "separator" },
    {
      kind: "item",
      label: "Overview of every deck",
      icon: LayoutGrid,
      shortcut: shortcutKeys("overview"),
      disabled: !project,
      onSelect: actions.showOverview,
    },
  ];
}

export function viewBarMenu(
  actions: TitlebarActions,
  sidebarVisible: boolean,
  inspectorVisible: boolean,
): MenuEntry[] {
  const { deck, focused } = inFront();
  const zoomed = Boolean(focused && deck?.zoomed === focused);

  return [
    {
      kind: "check",
      label: "Sidebar",
      checked: sidebarVisible,
      shortcut: shortcutKeys("toggleSidebar"),
      onChange: actions.toggleSidebar,
    },
    {
      kind: "check",
      label: "Files and git",
      checked: inspectorVisible,
      shortcut: shortcutKeys("toggleInspector"),
      onChange: actions.toggleInspector,
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Split right",
      icon: SplitSquareHorizontal,
      shortcut: shortcutKeys("splitRight"),
      disabled: !focused,
      onSelect: actions.splitRight,
    },
    {
      kind: "item",
      label: "Split down",
      icon: SplitSquareVertical,
      shortcut: shortcutKeys("splitDown"),
      disabled: !focused,
      onSelect: actions.splitDown,
    },
    {
      kind: "item",
      label: zoomed ? "Exit fullscreen" : "Fullscreen the focused pane",
      icon: zoomed ? Minimize2 : Maximize2,
      shortcut: shortcutKeys("fullscreen"),
      disabled: !focused,
      onSelect: actions.fullscreenPane,
    },
    {
      kind: "item",
      label: "Even out every split",
      icon: Columns3,
      shortcut: shortcutKeys("balance"),
      disabled: !deck?.tree,
      onSelect: actions.balance,
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Close the focused pane",
      icon: X,
      shortcut: shortcutKeys("closePane"),
      disabled: !focused,
      onSelect: actions.closePane,
    },
  ];
}

export function helpBarMenu(actions: TitlebarActions): MenuEntry[] {
  return [
    {
      kind: "item",
      label: "Keyboard shortcuts",
      icon: Keyboard,
      onSelect: actions.showShortcuts,
    },
    {
      kind: "item",
      label: "Agents & profiles…",
      icon: UsersRound,
      onSelect: actions.openCatalogue,
    },
    {
      kind: "item",
      label: "Private VPN…",
      icon: ShieldCheck,
      onSelect: actions.openVpn,
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Open the config folder",
      icon: FolderCog,
      onSelect: actions.openConfig,
    },
  ];
}

/** The empty part of the sidebar. */
export function sidebarMenu(): MenuEntry[] {
  const state = useKeel.getState();
  const any = state.projects.length > 0 || state.workspaces.length > 0;
  return [
    {
      kind: "item",
      label: "Add a folder…",
      icon: FolderPlus,
      onSelect: () => void pickProjectFolder(),
    },
    {
      kind: "item",
      label: "New workspace",
      icon: WorkspaceGlyph,
      onSelect: () => state.addWorkspace(),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Expand all",
      icon: ChevronsUpDown,
      disabled: !any,
      onSelect: () => state.setAllCollapsed(false),
    },
    {
      kind: "item",
      label: "Collapse all",
      icon: ChevronsDownUp,
      disabled: !any,
      onSelect: () => state.setAllCollapsed(true),
    },
  ];
}

function projectPlace(projectId: string) {
  const state = useKeel.getState();
  const group = workspaceOf(state.workspaces, projectId);
  if (group) {
    const index = group.projectIds.indexOf(projectId);
    return { index, last: group.projectIds.length - 1, group };
  }
  const sidebar = repairSidebar(state.projects, state.workspaces, state.sidebar);
  const index = sidebar.findIndex(
    (entry) => entry.kind === "project" && entry.id === projectId,
  );
  return { index, last: sidebar.length - 1, group: null };
}

export function projectMenu(projectId: string): MenuEntry[] {
  const state = useKeel.getState();
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return [];
  const count = project.decks.reduce(
    (sum, deck) => sum + listPanes(deck.tree).length,
    0,
  );
  const place = projectPlace(projectId);
  const others = state.workspaces.filter(
    (workspace) => workspace.id !== place.group?.id,
  );

  return [
    { kind: "label", label: project.name },
    {
      kind: "item",
      label: "Add terminals…",
      icon: Plus,
      shortcut: shortcutKeys("addTerminals"),
      onSelect: () => {
        state.selectProject(projectId);
        state.setLauncher(true);
      },
    },
    {
      kind: "item",
      label: "New deck",
      icon: Layers,
      shortcut: shortcutKeys("newDeck"),
      onSelect: () => {
        state.selectProject(projectId);
        state.addDeck(projectId);
      },
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Rename",
      icon: Pencil,
      shortcut: shortcutKeys("rename"),
      onSelect: () =>
        state.startRename({ kind: "project", id: projectId, where: "sidebar" }),
    },
    {
      kind: "item",
      label: project.collapsed ? "Expand" : "Collapse",
      icon: project.collapsed ? ChevronsUpDown : ChevronsDownUp,
      disabled: count === 0 && project.decks.length < 2,
      onSelect: () => state.toggleCollapsed(projectId),
    },
    {
      kind: "item",
      label: "Move up",
      icon: ArrowUp,
      disabled: place.index <= 0,
      onSelect: () => state.moveProject(projectId, -1),
    },
    {
      kind: "item",
      label: "Move down",
      icon: ArrowDown,
      disabled: place.index < 0 || place.index >= place.last,
      onSelect: () => state.moveProject(projectId, 1),
    },
    { kind: "separator" },
    {
      kind: "sub",
      label: "Move to workspace",
      icon: FolderInput,
      entries: [
        {
          kind: "item",
          label: "New workspace",
          icon: WorkspaceGlyph,
          onSelect: () => state.addWorkspace(projectId),
        },
        ...(others.length
          ? ([
              { kind: "separator" } as const,
              ...others.map(
                (workspace) =>
                  ({
                    kind: "item" as const,
                    label: workspace.name,
                    onSelect: () =>
                      state.placeProjectIn(projectId, {
                        kind: "member",
                        workspaceId: workspace.id,
                        index: workspace.projectIds.length,
                      }),
                  }),
              ),
            ] satisfies MenuEntry[])
          : []),
      ],
    },
    ...(place.group
      ? [
          {
            kind: "item" as const,
            label: "Remove from workspace",
            icon: FolderOutput,
            onSelect: () => {
              const sidebar = repairSidebar(
                state.projects,
                state.workspaces,
                state.sidebar,
              );
              const at = sidebar.findIndex(
                (entry) =>
                  entry.kind === "workspace" && entry.id === place.group!.id,
              );
              state.placeProjectIn(projectId, {
                kind: "root",
                index: at >= 0 ? at + 1 : sidebar.length,
              });
            },
          },
        ]
      : []),
    { kind: "separator" },
    {
      kind: "item",
      label: "Copy path",
      icon: Copy,
      onSelect: () => copyText(project.path),
    },
    {
      kind: "item",
      label: REVEAL_LABEL,
      icon: FolderOpen,
      onSelect: () => void revealItemInDir(project.path).catch(() => {}),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Remove project",
      icon: Trash2,
      destructive: true,
      confirm:
        count > 0 ? `Close ${plural(count, "terminal")} and remove` : "Click again to remove",
      onSelect: () => useWorkspace.getState().removeProjectSafely(projectId),
    },
  ];
}

export function workspaceMenu(workspaceId: string): MenuEntry[] {
  const state = useKeel.getState();
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return [];
  const sidebar = repairSidebar(state.projects, state.workspaces, state.sidebar);
  const index = sidebar.findIndex(
    (entry) => entry.kind === "workspace" && entry.id === workspaceId,
  );
  const count = workspace.projectIds.length;

  return [
    { kind: "label", label: workspace.name },
    {
      kind: "item",
      label: "Add a folder…",
      icon: FolderPlus,
      onSelect: () => void pickProjectFolder(workspaceId),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Rename",
      icon: Pencil,
      shortcut: shortcutKeys("rename"),
      onSelect: () =>
        state.startRename({
          kind: "workspace",
          id: workspaceId,
          where: "sidebar",
        }),
    },
    {
      kind: "item",
      label: workspace.collapsed ? "Expand" : "Collapse",
      icon: workspace.collapsed ? ChevronsUpDown : ChevronsDownUp,
      onSelect: () => state.toggleWorkspaceCollapsed(workspaceId),
    },
    {
      kind: "item",
      label: "Move up",
      icon: ArrowUp,
      disabled: index <= 0,
      onSelect: () => state.moveWorkspace(workspaceId, -1),
    },
    {
      kind: "item",
      label: "Move down",
      icon: ArrowDown,
      disabled: index < 0 || index >= sidebar.length - 1,
      onSelect: () => state.moveWorkspace(workspaceId, 1),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Ungroup workspace",
      icon: Ungroup,
      confirm: count > 0 ? `Ungroup ${plural(count, "project")}` : undefined,
      onSelect: () => state.dissolveWorkspace(workspaceId),
    },
  ];
}

export function deckMenu(projectId: string, deckId: string): MenuEntry[] {
  const state = useKeel.getState();
  const project = state.projects.find((item) => item.id === projectId);
  const index = project?.decks.findIndex((deck) => deck.id === deckId) ?? -1;
  const deck = project?.decks[index];
  if (!project || !deck) return [];
  const count = listPanes(deck.tree).length;

  return [
    { kind: "label", label: `Deck ${index + 1} · ${deck.name}` },
    {
      kind: "item",
      label: "Add terminals…",
      icon: Plus,
      shortcut: shortcutKeys("addTerminals"),
      onSelect: () => {
        state.selectProject(projectId);
        state.selectDeck(projectId, deckId);
        state.setLauncher(true);
      },
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Rename",
      icon: Pencil,
      shortcut: shortcutKeys("rename"),
      onSelect: () =>
        state.startRename({ kind: "deck", id: deckId, where: "sidebar" }),
    },
    {
      kind: "item",
      label: "Move up",
      icon: ArrowUp,
      disabled: index === 0,
      onSelect: () => state.moveDeck(projectId, deckId, -1),
    },
    {
      kind: "item",
      label: "Move down",
      icon: ArrowDown,
      disabled: index === project.decks.length - 1,
      onSelect: () => state.moveDeck(projectId, deckId, 1),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Close deck",
      icon: Trash2,
      destructive: true,
      confirm: count > 0 ? `Close ${plural(count, "terminal")}` : undefined,
      onSelect: () =>
        useWorkspace.getState().removeDeckSafely(projectId, deckId),
    },
  ];
}

export function paneMenu(
  projectId: string,
  paneId: string,
  where: RenameTarget["where"],
): MenuEntry[] {
  const state = useKeel.getState();
  const project = state.projects.find((item) => item.id === projectId);
  const deck = project ? deckOfPane(project, paneId) : null;
  const pane = deck?.panes[paneId];
  if (!project || !deck || !pane) return [];

  const agent = state.agents.find((item) => item.id === pane.agentId) ?? null;
  const cwd = pane.cwd ?? project.path;
  /** An editor pane runs nothing: no profile, no restart, no working directory. */
  const isEditor = pane.editor !== undefined;
  const otherDecks = project.decks.filter((item) => item.id !== deck.id);
  const profiles = agent?.accountEnv
    ? state.accounts.filter((account) => account.agentId === agent.id)
    : null;

  return [
    {
      kind: "item",
      label: "Rename",
      icon: Pencil,
      shortcut: shortcutKeys("rename"),
      onSelect: () => state.startRename({ kind: "pane", id: paneId, where }),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Split right",
      icon: SplitSquareHorizontal,
      shortcut: shortcutKeys("splitRight"),
      onSelect: () => state.duplicatePane(projectId, paneId, "row"),
    },
    {
      kind: "item",
      label: "Split down",
      icon: SplitSquareVertical,
      shortcut: shortcutKeys("splitDown"),
      onSelect: () => state.duplicatePane(projectId, paneId, "column"),
    },
    {
      kind: "item",
      label: deck.zoomed === paneId ? "Exit fullscreen" : "Fullscreen",
      icon: deck.zoomed === paneId ? Minimize2 : Maximize2,
      shortcut: shortcutKeys("fullscreen"),
      onSelect: () => state.toggleZoom(projectId, paneId),
    },
    {
      kind: "sub",
      label: "Move to deck",
      icon: Layers,
      entries: [
        ...otherDecks.map(
          (target): MenuEntry => ({
            kind: "item",
            label: `${project.decks.indexOf(target) + 1} · ${target.name}`,
            onSelect: () => state.movePaneToDeck(projectId, paneId, target.id),
          }),
        ),
        { kind: "separator" },
        {
          kind: "item",
          label: "New deck",
          icon: Plus,
          onSelect: () => {
            const target = state.addDeck(projectId);
            if (target) state.movePaneToDeck(projectId, paneId, target);
          },
        },
      ],
    },
    { kind: "separator" },
    ...(profiles && agent && !isEditor
      ? [
          {
            kind: "sub",
            label: "Profile",
            icon: UserRound,
            entries: [
              {
                kind: "radio",
                value: pane.accountId ?? DEFAULT_PROFILE,
                options: [
                  { value: DEFAULT_PROFILE, label: "Default" },
                  ...profiles.map((profile) => ({
                    value: profile.id,
                    label: profile.name,
                  })),
                ],
                onChange: (value: string) => {
                  const next = value === DEFAULT_PROFILE ? null : value;
                  if (next === pane.accountId) return;
                  state.setPaneAccount(projectId, paneId, next);
                  state.restartPane(paneId);
                },
              },
              { kind: "separator" },
              {
                kind: "item",
                label: "Manage profiles…",
                icon: Settings2,
                onSelect: () => state.openAgentSettings(agent.id),
              },
            ],
          } satisfies MenuEntry,
        ]
      : []),
    ...(isEditor
      ? []
      : ([
          ...(pane.agentId
            ? [
                {
                  kind: "check" as const,
                  label: "Mute notifications",
                  checked: pane.muted === true,
                  onChange: (checked: boolean) =>
                    state.setPaneMuted(paneId, checked),
                } satisfies MenuEntry,
              ]
            : []),
          {
            kind: "item",
            label: "Restart",
            icon: RotateCw,
            onSelect: () => state.restartPane(paneId),
          },
          { kind: "separator" },
          {
            kind: "item",
            label: "Copy working directory",
            icon: Copy,
            onSelect: () => copyText(cwd),
          },
          {
            kind: "item",
            label: REVEAL_LABEL,
            icon: FolderOpen,
            onSelect: () => void revealItemInDir(cwd).catch(() => {}),
          },
        ] satisfies MenuEntry[])),
    { kind: "separator" },
    {
      kind: "item",
      label: isEditor ? "Close editor" : "Close terminal",
      icon: X,
      shortcut: shortcutKeys("closePane"),
      destructive: true,
      onSelect: () => useWorkspace.getState().closePaneSafely(projectId, paneId),
    },
  ];
}

/** Right-clicking the terminal itself: text first, then the pane's actions. */
export function terminalMenu(projectId: string, paneId: string): MenuEntry[] {
  const terminal = terminalCommands(paneId);
  return [
    {
      kind: "item",
      label: "Copy",
      icon: Copy,
      disabled: !terminal.hasSelection(),
      onSelect: terminal.copy,
    },
    {
      kind: "item",
      label: "Paste",
      icon: ClipboardPaste,
      shortcut: "Ctrl+V",
      onSelect: terminal.paste,
    },
    {
      kind: "item",
      label: "Select all",
      icon: TextSelect,
      onSelect: terminal.selectAll,
    },
    {
      kind: "item",
      label: "Find in scrollback",
      icon: Search,
      shortcut: "Ctrl+F",
      onSelect: terminal.find,
    },
    {
      kind: "item",
      label: "Clear scrollback",
      icon: Eraser,
      onSelect: terminal.clear,
    },
    { kind: "separator" },
    ...paneMenu(projectId, paneId, "pane"),
  ];
}
