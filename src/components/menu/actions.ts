/**
 * Every right-click menu in the app, as data.
 *
 * Each builder reads the store at the moment the menu opens, so the entries
 * describe what is true right now. Actions call the store directly — a menu is
 * just another way of reaching the same operations as the keyboard and buttons.
 */

import { open as openFolder } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArrowDown,
  ArrowUp,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardPaste,
  Copy,
  Eraser,
  FolderOpen,
  FolderPlus,
  Layers,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RotateCw,
  Settings2,
  SplitSquareHorizontal,
  SplitSquareVertical,
  TextSelect,
  Trash2,
  UserRound,
  X,
} from "lucide-react";

import type { MenuEntry } from "@/components/menu/MenuEntries";
import { terminalCommands } from "@/components/TerminalSurface";
import { listPanes } from "@/lib/tree";
import { deckOfPane, useKeel, type RenameTarget } from "@/state/store";

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

export async function pickProjectFolder() {
  const picked = await openFolder({
    directory: true,
    multiple: false,
    title: "Add a project folder",
  });
  if (typeof picked === "string") useKeel.getState().addProject(picked);
}

/** The empty part of the sidebar. */
export function sidebarMenu(): MenuEntry[] {
  const state = useKeel.getState();
  const any = state.projects.length > 0;
  return [
    {
      kind: "item",
      label: "Add a folder…",
      icon: FolderPlus,
      onSelect: () => void pickProjectFolder(),
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

export function projectMenu(projectId: string): MenuEntry[] {
  const state = useKeel.getState();
  const index = state.projects.findIndex((item) => item.id === projectId);
  const project = state.projects[index];
  if (!project) return [];
  const count = project.decks.reduce(
    (sum, deck) => sum + listPanes(deck.tree).length,
    0,
  );

  return [
    { kind: "label", label: project.name },
    {
      kind: "item",
      label: "Add terminals…",
      icon: Plus,
      shortcut: "Alt+Shift+T",
      onSelect: () => {
        state.selectProject(projectId);
        state.setLauncher(true);
      },
    },
    {
      kind: "item",
      label: "New deck",
      icon: Layers,
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
      shortcut: "F2",
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
      disabled: index === 0,
      onSelect: () => state.moveProject(projectId, -1),
    },
    {
      kind: "item",
      label: "Move down",
      icon: ArrowDown,
      disabled: index === state.projects.length - 1,
      onSelect: () => state.moveProject(projectId, 1),
    },
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
      onSelect: () => state.removeProject(projectId),
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
      shortcut: "F2",
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
      onSelect: () => state.removeDeck(projectId, deckId),
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
  const otherDecks = project.decks.filter((item) => item.id !== deck.id);
  const profiles = agent?.accountEnv
    ? state.accounts.filter((account) => account.agentId === agent.id)
    : null;

  return [
    {
      kind: "item",
      label: "Rename",
      icon: Pencil,
      shortcut: "F2",
      onSelect: () => state.startRename({ kind: "pane", id: paneId, where }),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Split right",
      icon: SplitSquareHorizontal,
      shortcut: "Alt+Shift+D",
      onSelect: () => state.duplicatePane(projectId, paneId, "row"),
    },
    {
      kind: "item",
      label: "Split down",
      icon: SplitSquareVertical,
      shortcut: "Alt+Shift+S",
      onSelect: () => state.duplicatePane(projectId, paneId, "column"),
    },
    {
      kind: "item",
      label: deck.zoomed === paneId ? "Exit fullscreen" : "Fullscreen",
      icon: deck.zoomed === paneId ? Minimize2 : Maximize2,
      shortcut: "Alt+Shift+F",
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
    ...(profiles && agent
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
    { kind: "separator" },
    {
      kind: "item",
      label: "Close terminal",
      icon: X,
      shortcut: "Alt+Shift+W",
      destructive: true,
      onSelect: () => state.closePane(projectId, paneId),
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
      label: "Clear scrollback",
      icon: Eraser,
      onSelect: terminal.clear,
    },
    { kind: "separator" },
    ...paneMenu(projectId, paneId, "pane"),
  ];
}
