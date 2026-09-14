/**
 * The single source of truth: projects, their decks, and the terminals inside.
 *
 * Pane operations are addressed by `(projectId, paneId)` and find their own deck.
 * Callers almost never care which deck a terminal is on â€” the store does, so the
 * deck layer stays invisible right up until you actually open a second one.
 *
 * Live terminal state (bytes, PTY handles) deliberately does not live here. Only
 * the arrangement does, because the arrangement is what gets written to disk.
 */

import { create } from "zustand";

import * as backend from "@/lib/backend";
import { killPty } from "@/lib/pty";
import {
  balance,
  closePane as closeInTree,
  gridOf,
  listPanes,
  movePane as moveInTree,
  neighbourPane,
  paneLeaf,
  resizeSplit,
  splitPane,
  type MoveDirection,
} from "@/lib/tree";
import type {
  Agent,
  AgentAccount,
  AgentSpec,
  Deck,
  Direction,
  Pane,
  PaneActivity,
  PaneStatus,
  PersistedState,
  Project,
} from "@/lib/types";

/** UI-only reopen chrome. Never written to PersistedState. */
export type RestoreStatus = "idle" | "restoring" | "partial" | "failed";

/**
 * Per-pane output bookkeeping. Lives outside the store on purpose: a busy agent
 * writes hundreds of times a second and none of that should re-render React.
 */
interface Activity {
  /** When the current process was started. */
  spawnedAt: number;
  /** Last keystroke (or mouse / focus report) sent to the process. */
  lastInput: number;
  /** Last time the grid changed size, which makes a TUI repaint. */
  lastResize: number;
  lastOutput: number;
  /** Start of the current burst of unprompted output; `null` between bursts. */
  runStart: number | null;
}
const activity = new Map<string, Activity>();
/** Pane ids that already reported a post-reopen spawn settle. */
const restoreSettled = new Set<string>();

function activityOf(paneId: string): Activity {
  let entry = activity.get(paneId);
  if (!entry) {
    entry = {
      spawnedAt: 0,
      lastInput: 0,
      lastResize: 0,
      lastOutput: 0,
      runStart: null,
    };
    activity.set(paneId, entry);
  }
  return entry;
}

/*
 * "Working" is read off output alone, so these thresholds are all about telling
 * an agent at work apart from everything else that makes a terminal print.
 */
/** Output this soon after a keystroke or resize is the terminal answering it. */
const REPLY_MS = 300;
/** An agent's launch banner and first paint are not work. */
const STARTUP_MS = 6_000;
/** A burst has to keep going this long to be work rather than a redraw. */
const MIN_RUN_MS = 1_200;
/** Silence this long ends a burst: the agent was working and is now done. */
const QUIET_MS = 3_000;

/** A name being edited in place, and which copy of it on screen is the editor. */
export interface RenameTarget {
  kind: "project" | "deck" | "pane";
  id: string;
  /** A pane's name shows in both the sidebar and its own header. */
  where: "sidebar" | "pane";
}

/** What a caller needs to describe a terminal it wants opened. */
export interface PaneSpec {
  agentId: string | null;
  accountId?: string | null;
  cwd?: string | null;
  title?: string;
}

export interface KeelState {
  ready: boolean;
  agents: Agent[];
  accounts: AgentAccount[];
  projects: Project[];
  activeProjectId: string | null;
  /** Recomputed on a timer from output timing, never written to disk. */
  status: Record<string, PaneStatus>;
  /** Panes whose shell has exited. Not persisted. */
  exited: Record<string, true>;
  /** Session reopen chrome — not persisted. */
  restoreStatus: RestoreStatus;
  /** Panes still settling after a layout reopen. */
  restoreLeft: number;
  /** Host IPC looks dead (UI banner). Not persisted. */
  hostLost: boolean;

  init: () => Promise<void>;
  /** Re-run state_load / hydrate after a failed restore. */
  retryRestore: () => Promise<void>;
  /** Abandon broken session layout → empty projects UI. */
  resetLayout: () => void;
  /** Pane finished its post-reopen spawn attempt. */
  settleRestore: (paneId: string, ok: boolean) => void;
  noteSpawnFail: (paneId: string) => void;
  noteHostLost: () => void;
  clearHostLost: () => void;
  refreshAgents: () => Promise<void>;
  addAccount: (agentId: string, name: string) => string | null;
  setPaneAccount: (
    projectId: string,
    paneId: string,
    accountId: string | null,
  ) => void;
  renameAccount: (accountId: string, name: string) => void;
  /** Panes signed in with it fall back to the default login and restart. */
  removeAccount: (accountId: string) => void;
  /** Replace the agent catalogue on disk and re-detect. Rejects invalid input. */
  saveAgents: (agents: AgentSpec[]) => Promise<void>;

  /** Bumped to respawn a pane's process in the same terminal. Not persisted. */
  generations: Record<string, number>;
  restartPane: (paneId: string) => void;

  /** The agents & profiles dialog; `agentId` preselects an agent. */
  agentSettings: { open: boolean; agentId: string | null };
  openAgentSettings: (agentId?: string | null) => void;
  closeAgentSettings: () => void;

  /** The Add terminals dialog. */
  launcher: boolean;
  setLauncher: (open: boolean) => void;

  /** Which name is being edited in place, if any. */
  renaming: RenameTarget | null;
  startRename: (target: RenameTarget) => void;
  stopRename: () => void;

  renameProject: (projectId: string, name: string) => void;
  renamePane: (projectId: string, paneId: string, title: string) => void;
  /** Shift a project one place up or down the sidebar. */
  moveProject: (projectId: string, delta: -1 | 1) => void;
  /** Shift a deck one place; its number follows its position. */
  moveDeck: (projectId: string, deckId: string, delta: -1 | 1) => void;
  setAllCollapsed: (collapsed: boolean) => void;

  addProject: (path: string, name?: string) => Project;
  removeProject: (projectId: string) => void;
  /** Selection only ever moves to another project; it is never cleared. */
  selectProject: (projectId: string) => void;
  toggleCollapsed: (projectId: string) => void;

  addDeck: (projectId: string, name?: string) => string | null;
  removeDeck: (projectId: string, deckId: string) => void;
  renameDeck: (projectId: string, deckId: string, name: string) => void;
  selectDeck: (projectId: string, deckId: string) => void;
  /** Carry a running terminal to another deck without restarting it. */
  movePaneToDeck: (projectId: string, paneId: string, deckId: string) => void;

  addPane: (
    projectId: string,
    spec: PaneSpec,
    placement?: { beside?: string | null; direction?: Direction },
  ) => string | null;
  addPanes: (projectId: string, specs: PaneSpec[]) => void;
  duplicatePane: (
    projectId: string,
    paneId: string,
    direction: Direction,
  ) => void;
  closePane: (projectId: string, paneId: string) => void;
  focusPane: (projectId: string, paneId: string) => void;
  cyclePane: (projectId: string, step: 1 | -1) => void;
  movePane: (
    projectId: string,
    paneId: string,
    direction: MoveDirection,
  ) => void;
  resizeSplit: (
    projectId: string,
    deckId: string,
    splitId: string,
    seam: number,
    delta: number,
  ) => void;
  balanceLayout: (projectId: string) => void;
  toggleZoom: (projectId: string, paneId: string) => void;

  noteOutput: (paneId: string) => void;
  noteActivity: (paneId: string, kind: PaneActivity) => void;
  notePaneExit: (paneId: string) => void;
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function defaultTitle(agents: Agent[], agentId: string | null): string {
  if (!agentId) return "Shell";
  return agents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Move the first matching item one place along, clamped to the ends. */
function shift<T>(items: T[], match: (item: T) => boolean, delta: -1 | 1): T[] {
  const from = items.findIndex(match);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= items.length) return items;
  const next = [...items];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** "Profile N" with the lowest N none of these profiles is already using. */
export function nextProfileName(accounts: AgentAccount[]): string {
  const taken = new Set(
    accounts.map((account) => account.name.toLocaleLowerCase()),
  );
  for (let index = 1; ; index += 1) {
    if (!taken.has(`profile ${index}`)) return `Profile ${index}`;
  }
}

export function emptyDeck(name: string): Deck {
  return {
    id: makeId("deck"),
    name,
    tree: null,
    panes: {},
    zoomed: null,
    focused: null,
  };
}

function countPanes(projects: Project[]): number {
  let total = 0;
  for (const project of projects) {
    for (const deck of project.decks) {
      total += Object.keys(deck.panes).length;
    }
  }
  return total;
}

/** Add fields introduced after v3 without disturbing the saved layout tree. */
function normalizeProjects(projects: Project[]): Project[] {
  return projects.map((project) => ({
    ...project,
    decks: project.decks.map((deck) => ({
      ...deck,
      panes: Object.fromEntries(
        Object.entries(deck.panes).map(([id, pane]) => [
          id,
          { ...pane, accountId: pane.accountId ?? null },
        ]),
      ),
    })),
  }));
}

function readAccounts(document: Record<string, unknown> | null): AgentAccount[] {
  if (!document || document.version !== 4 || !Array.isArray(document.accounts)) {
    return [];
  }
  return document.accounts.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const account = entry as Record<string, unknown>;
    if (
      typeof account.id !== "string" ||
      typeof account.agentId !== "string" ||
      typeof account.name !== "string"
    ) {
      return [];
    }
    return [
      {
        id: account.id,
        agentId: account.agentId,
        name: account.name,
      } satisfies AgentAccount,
    ];
  });
}

/** The deck a pane is sitting on, or `null` if the project has never seen it. */
export function deckOfPane(project: Project, paneId: string): Deck | null {
  return project.decks.find((deck) => paneId in deck.panes) ?? null;
}

export function activeDeck(project: Project | null | undefined): Deck | null {
  if (!project) return null;
  return (
    project.decks.find((deck) => deck.id === project.activeDeckId) ??
    project.decks[0] ??
    null
  );
}

/** The most notable agent state on a deck. Never "idle". */
export type Attention = Exclude<PaneStatus, "idle">;

export function deckAttention(
  deck: Deck,
  status: Record<string, PaneStatus>,
): Attention | null {
  // Aggregate: working > done > idle
  const rank: Record<Attention, number> = {
    working: 2,
    done: 1,
  };
  let best: Attention | null = null;
  for (const paneId of Object.keys(deck.panes)) {
    const state = status[paneId] ?? "idle";
    if (state === "idle") continue;
    if (!best || rank[state] > rank[best]) best = state;
  }
  return best;
}

/**
 * Earlier builds put the layout straight on the project (v2), and before that
 * kept workspaces and saved setups above it (v1). Carry the folders across in
 * both cases and fold any surviving layout into a first deck.
 */
function migrate(saved: unknown): Project[] {
  if (!saved || typeof saved !== "object") return [];
  const document = saved as Record<string, unknown>;
  const projects = Array.isArray(document.projects) ? document.projects : [];

  return projects.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const project = entry as Record<string, unknown>;
    if (typeof project.path !== "string" || typeof project.id !== "string") {
      return [];
    }

    const deck = emptyDeck("Deck 1");
    // v2 kept `tree` and `panes` on the project itself.
    if (project.tree && typeof project.panes === "object" && project.panes) {
      deck.tree = project.tree as Deck["tree"];
      deck.panes = project.panes as Deck["panes"];
    }

    return [
      {
        id: project.id,
        name:
          typeof project.name === "string"
            ? project.name
            : basename(project.path),
        path: project.path,
        decks: [deck],
        activeDeckId: deck.id,
        collapsed: false,
      } satisfies Project,
    ];
  });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useKeel = create<KeelState>((set, get) => {
  /** Debounced write-through. Every mutation calls this; disk sees one write. */
  function persist() {
    if (!get().ready) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { projects, activeProjectId, accounts } = get();
      const document: PersistedState = {
        version: 4,
        projects,
        activeProjectId,
        accounts,
      };
      void backend.saveState(document).catch(() => {
        /* A failed save should never interrupt what the user is doing. */
      });
    }, 400);
  }

  function updateProject(
    projectId: string,
    change: (project: Project) => Project,
  ) {
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === projectId ? change(project) : project,
      ),
    }));
    persist();
  }

  /** Edit one deck in place, leaving the rest of the project alone. */
  function updateDeck(
    projectId: string,
    deckId: string,
    change: (deck: Deck) => Deck,
  ) {
    updateProject(projectId, (project) => ({
      ...project,
      decks: project.decks.map((deck) =>
        deck.id === deckId ? change(deck) : deck,
      ),
    }));
  }

  /** Edit whichever deck holds `paneId`. Most pane actions go through here. */
  function updateDeckOfPane(
    projectId: string,
    paneId: string,
    change: (deck: Deck) => Deck,
  ) {
    const project = get().projects.find((item) => item.id === projectId);
    const deck = project ? deckOfPane(project, paneId) : null;
    if (!deck) return;
    updateDeck(projectId, deck.id, change);
  }

  /** Looking at a finished agent — focusing it, typing into it — clears "done". */
  function acknowledge(paneId: string) {
    if (get().status[paneId] !== "done") return;
    set((state) => ({ status: { ...state.status, [paneId]: "idle" } }));
  }

  return {
    ready: false,
    agents: [],
    accounts: [],
    projects: [],
    activeProjectId: null,
    status: {},
    exited: {},
    generations: {},
    agentSettings: { open: false, agentId: null },
    launcher: false,
    renaming: null,
    restoreStatus: "restoring",
    restoreLeft: 0,
    hostLost: false,

    async init() {
      restoreSettled.clear();
      set({
        restoreStatus: "restoring",
        restoreLeft: 0,
        ready: false,
        hostLost: false,
      });

      let agents: Agent[] = [];
      let saved: PersistedState | null = null;
      try {
        agents = await backend.detectAgents().catch(() => [] as Agent[]);
        saved = await backend.loadState();
      } catch {
        set({
          agents,
          accounts: [],
          projects: [],
          activeProjectId: null,
          ready: true,
          restoreStatus: "failed",
          restoreLeft: 0,
          status: {},
          exited: {},
        });
        return;
      }

      const document = saved as unknown as Record<string, unknown> | null;
      const projects = normalizeProjects(
        document && (document.version === 3 || document.version === 4)
          ? ((document.projects as Project[]) ?? [])
          : migrate(document),
      );
      const accounts = readAccounts(document);

      const wanted = document?.activeProjectId as string | null | undefined;
      const activeProjectId =
        wanted && projects.some((project) => project.id === wanted)
          ? wanted
          : (projects[0]?.id ?? null);

      const paneCount = countPanes(projects);
      set({
        agents,
        accounts,
        projects,
        activeProjectId,
        ready: true,
        restoreStatus: paneCount > 0 ? "restoring" : "idle",
        restoreLeft: paneCount,
        status: {},
        exited: {},
      });

      // Safety: never leave Restoring… forever if a pane never settles.
      if (paneCount > 0) {
        window.setTimeout(() => {
          const current = get();
          if (current.restoreStatus !== "restoring") return;
          const anyDead = Object.keys(current.exited).length > 0;
          set({
            restoreStatus: anyDead ? "partial" : "idle",
            restoreLeft: 0,
          });
        }, 8_000);
      }
    },

    async retryRestore() {
      await get().init();
    },

    resetLayout() {
      const { projects } = get();
      for (const project of projects) {
        for (const deck of project.decks) {
          for (const paneId of Object.keys(deck.panes)) {
            void killPty(paneId).catch(() => {});
            activity.delete(paneId);
          }
        }
      }
      set({
        accounts: [],
        projects: [],
        activeProjectId: null,
        status: {},
        exited: {},
        restoreStatus: "idle",
        restoreLeft: 0,
        ready: true,
      });
      persist();
    },

    settleRestore(paneId, ok) {
      if (!ok) get().notePaneExit(paneId);

      const state = get();
      if (state.restoreStatus !== "restoring") return;
      if (restoreSettled.has(paneId)) return;
      restoreSettled.add(paneId);

      const left = Math.max(0, state.restoreLeft - 1);
      const anyDead = !ok || Object.keys(get().exited).length > 0;

      set({
        restoreLeft: left,
        restoreStatus: left === 0 ? (anyDead ? "partial" : "idle") : "restoring",
      });
    },

    noteSpawnFail(paneId) {
      get().settleRestore(paneId, false);
    },

    noteHostLost() {
      if (get().hostLost) return;
      set({ hostLost: true });
    },

    clearHostLost() {
      set({ hostLost: false });
    },

    async refreshAgents() {
      set({ agents: await backend.detectAgents().catch(() => []) });
    },

    addAccount(agentId, name) {
      const clean = name.trim();
      if (!clean) return null;
      const existing = get().accounts.find(
        (account) =>
          account.agentId === agentId &&
          account.name.toLocaleLowerCase() === clean.toLocaleLowerCase(),
      );
      if (existing) return existing.id;

      const id = makeId("acct");
      set((state) => ({
        accounts: [...state.accounts, { id, agentId, name: clean }],
      }));
      persist();
      return id;
    },

    setPaneAccount(projectId, paneId, accountId) {
      const project = get().projects.find((item) => item.id === projectId);
      const deck = project ? deckOfPane(project, paneId) : null;
      const pane = deck?.panes[paneId];
      if (!project || !deck || !pane) return;
      if (accountId) {
        const account = get().accounts.find((item) => item.id === accountId);
        if (!account || account.agentId !== pane.agentId) return;
      }
      updateDeck(projectId, deck.id, (current) => ({
        ...current,
        panes: {
          ...current.panes,
          [paneId]: { ...current.panes[paneId], accountId },
        },
      }));
    },

    renameAccount(accountId, name) {
      const clean = name.trim();
      if (!clean) return;
      set((state) => ({
        accounts: state.accounts.map((account) =>
          account.id === accountId ? { ...account, name: clean } : account,
        ),
      }));
      persist();
    },

    removeAccount(accountId) {
      const affected: string[] = [];
      set((state) => ({
        accounts: state.accounts.filter((account) => account.id !== accountId),
        projects: state.projects.map((project) => ({
          ...project,
          decks: project.decks.map((deck) => {
            let touched = false;
            const panes = Object.fromEntries(
              Object.entries(deck.panes).map(([id, pane]) => {
                if (pane.accountId !== accountId) return [id, pane];
                touched = true;
                affected.push(id);
                return [id, { ...pane, accountId: null }];
              }),
            );
            return touched ? { ...deck, panes } : deck;
          }),
        })),
      }));
      persist();
      // Those agents are still signed in with a profile that no longer exists;
      // start them again on the default login so the header tells the truth.
      for (const paneId of affected) get().restartPane(paneId);
    },

    async saveAgents(agents) {
      const detected = await backend.saveAgentCatalogue(agents);
      set({ agents: detected });
    },

    restartPane(paneId) {
      set((state) => ({
        generations: {
          ...state.generations,
          [paneId]: (state.generations[paneId] ?? 0) + 1,
        },
      }));
    },

    openAgentSettings(agentId = null) {
      set({ agentSettings: { open: true, agentId } });
    },

    closeAgentSettings() {
      set((state) => ({
        agentSettings: { ...state.agentSettings, open: false },
      }));
    },

    setLauncher(open) {
      set({ launcher: open });
    },

    startRename(target) {
      set({ renaming: target });
    },

    stopRename() {
      set({ renaming: null });
    },

    renameProject(projectId, name) {
      const clean = name.trim();
      if (!clean) return;
      updateProject(projectId, (project) => ({ ...project, name: clean }));
    },

    renamePane(projectId, paneId, title) {
      const clean = title.trim();
      if (!clean) return;
      updateDeckOfPane(projectId, paneId, (deck) => ({
        ...deck,
        panes: {
          ...deck.panes,
          [paneId]: { ...deck.panes[paneId], title: clean },
        },
      }));
    },

    moveProject(projectId, delta) {
      set((state) => ({
        projects: shift(state.projects, (item) => item.id === projectId, delta),
      }));
      persist();
    },

    moveDeck(projectId, deckId, delta) {
      updateProject(projectId, (project) => ({
        ...project,
        decks: shift(project.decks, (deck) => deck.id === deckId, delta),
      }));
    },

    setAllCollapsed(collapsed) {
      set((state) => ({
        projects: state.projects.map((project) => ({ ...project, collapsed })),
      }));
      persist();
    },

    addProject(path, name) {
      const existing = get().projects.find((project) => project.path === path);
      if (existing) {
        set({ activeProjectId: existing.id });
        persist();
        return existing;
      }

      const deck = emptyDeck("Deck 1");
      const project: Project = {
        id: makeId("prj"),
        name: name?.trim() || basename(path),
        path,
        decks: [deck],
        activeDeckId: deck.id,
        collapsed: false,
      };
      set((state) => ({
        projects: [...state.projects, project],
        activeProjectId: project.id,
      }));
      persist();
      return project;
    },

    removeProject(projectId) {
      const project = get().projects.find((item) => item.id === projectId);
      // The terminals only existed inside this project; take them with it.
      for (const deck of project?.decks ?? []) {
        for (const paneId of Object.keys(deck.panes)) {
          void killPty(paneId).catch(() => {});
          activity.delete(paneId);
        }
      }
      set((state) => {
        const projects = state.projects.filter((item) => item.id !== projectId);
        return {
          projects,
          activeProjectId:
            state.activeProjectId === projectId
              ? (projects[0]?.id ?? null)
              : state.activeProjectId,
        };
      });
      persist();
    },

    selectProject(projectId) {
      // Deliberately one-way: picking a project never unpicks the current one.
      if (!get().projects.some((project) => project.id === projectId)) return;
      set({ activeProjectId: projectId });
      persist();
    },

    toggleCollapsed(projectId) {
      updateProject(projectId, (project) => ({
        ...project,
        collapsed: !project.collapsed,
      }));
    },

    addDeck(projectId, name) {
      const project = get().projects.find((item) => item.id === projectId);
      if (!project) return null;
      const deck = emptyDeck(name?.trim() || `Deck ${project.decks.length + 1}`);
      updateProject(projectId, (current) => ({
        ...current,
        decks: [...current.decks, deck],
        activeDeckId: deck.id,
      }));
      return deck.id;
    },

    removeDeck(projectId, deckId) {
      const project = get().projects.find((item) => item.id === projectId);
      const deck = project?.decks.find((item) => item.id === deckId);
      if (!project || !deck) return;

      for (const paneId of Object.keys(deck.panes)) {
        void killPty(paneId).catch(() => {});
        activity.delete(paneId);
      }

      updateProject(projectId, (current) => {
        // A project always has at least one deck to put terminals on.
        const remaining = current.decks.filter((item) => item.id !== deckId);
        const decks = remaining.length > 0 ? remaining : [emptyDeck("Deck 1")];
        return {
          ...current,
          decks,
          activeDeckId:
            current.activeDeckId === deckId
              ? decks[0].id
              : current.activeDeckId,
        };
      });
    },

    renameDeck(projectId, deckId, name) {
      updateDeck(projectId, deckId, (deck) => ({
        ...deck,
        name: name.trim() || deck.name,
      }));
    },

    selectDeck(projectId, deckId) {
      updateProject(projectId, (project) =>
        project.decks.some((deck) => deck.id === deckId)
          ? { ...project, activeDeckId: deckId }
          : project,
      );
    },

    movePaneToDeck(projectId, paneId, deckId) {
      const project = get().projects.find((item) => item.id === projectId);
      const from = project ? deckOfPane(project, paneId) : null;
      if (!project || !from || from.id === deckId) return;
      const pane = from.panes[paneId];
      if (!pane) return;

      updateProject(projectId, (current) => ({
        ...current,
        decks: current.decks.map((deck) => {
          if (deck.id === from.id) {
            const panes = { ...deck.panes };
            delete panes[paneId];
            const tree = closeInTree(deck.tree, paneId);
            return {
              ...deck,
              tree,
              panes,
              focused:
                deck.focused === paneId
                  ? (listPanes(tree)[0] ?? null)
                  : deck.focused,
              zoomed: deck.zoomed === paneId ? null : deck.zoomed,
            };
          }
          if (deck.id === deckId) {
            return {
              ...deck,
              // The terminal keeps running; only its rectangle moves.
              tree: gridOf([...listPanes(deck.tree), paneId]),
              panes: { ...deck.panes, [paneId]: pane },
              focused: paneId,
              zoomed: null,
            };
          }
          return deck;
        }),
      }));
    },

    addPane(projectId, spec, placement = {}) {
      const project = get().projects.find((item) => item.id === projectId);
      const deck = activeDeck(project);
      if (!project || !deck) return null;

      const paneId = makeId("pane");
      const agents = get().agents;
      updateDeck(projectId, deck.id, (current) => {
        const pane: Pane = {
          id: paneId,
          agentId: spec.agentId,
          accountId: spec.accountId ?? null,
          title: spec.title ?? defaultTitle(agents, spec.agentId),
          cwd: spec.cwd ?? null,
        };
        const beside = placement.beside ?? current.focused;
        const tree = !current.tree
          ? paneLeaf(paneId)
          : beside && listPanes(current.tree).includes(beside)
            ? splitPane(current.tree, beside, placement.direction ?? "row", paneId)
            : gridOf([...listPanes(current.tree), paneId]);
        return {
          ...current,
          tree,
          panes: { ...current.panes, [paneId]: pane },
          focused: paneId,
          zoomed: null,
        };
      });
      return paneId;
    },

    addPanes(projectId, specs) {
      if (specs.length === 0) return;
      const project = get().projects.find((item) => item.id === projectId);
      const deck = activeDeck(project);
      if (!project || !deck) return;

      const agents = get().agents;
      updateDeck(projectId, deck.id, (current) => {
        const panes = { ...current.panes };
        const ids: string[] = [];
        for (const spec of specs) {
          const paneId = makeId("pane");
          ids.push(paneId);
          panes[paneId] = {
            id: paneId,
            agentId: spec.agentId,
            accountId: spec.accountId ?? null,
            title: spec.title ?? defaultTitle(agents, spec.agentId),
            cwd: spec.cwd ?? null,
          };
        }
        // Several at once means a batch launch â€” lay them out as a grid.
        return {
          ...current,
          tree: gridOf([...listPanes(current.tree), ...ids]),
          panes,
          focused: ids[0] ?? current.focused,
          zoomed: null,
        };
      });
    },

    duplicatePane(projectId, paneId, direction) {
      const project = get().projects.find((item) => item.id === projectId);
      const deck = project ? deckOfPane(project, paneId) : null;
      const source = deck?.panes[paneId];
      if (!project || !deck || !source) return;

      // Splitting always lands on the deck the original is on.
      const previous = project.activeDeckId;
      if (previous !== deck.id) get().selectDeck(projectId, deck.id);
      get().addPane(
        projectId,
        {
          agentId: source.agentId,
          accountId: source.accountId,
          cwd: source.cwd,
        },
        { beside: paneId, direction },
      );
    },

    closePane(projectId, paneId) {
      void killPty(paneId).catch(() => {});
      activity.delete(paneId);
      updateDeckOfPane(projectId, paneId, (deck) => {
        const tree = closeInTree(deck.tree, paneId);
        const panes = { ...deck.panes };
        delete panes[paneId];
        const remaining = listPanes(tree);
        return {
          ...deck,
          tree,
          panes,
          focused:
            deck.focused === paneId ? (remaining[0] ?? null) : deck.focused,
          zoomed: deck.zoomed === paneId ? null : deck.zoomed,
        };
      });
      set((state) => {
        const status = { ...state.status };
        delete status[paneId];
        const exited = { ...state.exited };
        delete exited[paneId];
        return { status, exited };
      });
    },

    focusPane(projectId, paneId) {
      const project = get().projects.find((item) => item.id === projectId);
      const deck = project ? deckOfPane(project, paneId) : null;
      if (!project || !deck) return;
      acknowledge(paneId);
      if (deck.focused === paneId && project.activeDeckId === deck.id) return;

      // Reaching for a terminal brings its deck forward with it.
      updateProject(projectId, (current) => ({
        ...current,
        activeDeckId: deck.id,
        decks: current.decks.map((item) =>
          item.id === deck.id ? { ...item, focused: paneId } : item,
        ),
      }));
    },

    cyclePane(projectId, step) {
      const project = get().projects.find((item) => item.id === projectId);
      const deck = activeDeck(project);
      if (!project || !deck?.focused) return;
      const next = neighbourPane(deck.tree, deck.focused, step);
      if (next) get().focusPane(projectId, next);
    },

    movePane(projectId, paneId, direction) {
      updateDeckOfPane(projectId, paneId, (deck) =>
        deck.tree
          ? { ...deck, tree: moveInTree(deck.tree, paneId, direction) }
          : deck,
      );
    },

    resizeSplit(projectId, deckId, splitId, seam, delta) {
      updateDeck(projectId, deckId, (deck) =>
        deck.tree
          ? { ...deck, tree: resizeSplit(deck.tree, splitId, seam, delta) }
          : deck,
      );
    },

    balanceLayout(projectId) {
      const deck = activeDeck(
        get().projects.find((item) => item.id === projectId),
      );
      if (!deck) return;
      updateDeck(projectId, deck.id, (current) =>
        current.tree ? { ...current, tree: balance(current.tree) } : current,
      );
    },

    toggleZoom(projectId, paneId) {
      updateDeckOfPane(projectId, paneId, (deck) => ({
        ...deck,
        zoomed: deck.zoomed === paneId ? null : paneId,
        focused: paneId,
      }));
    },

    noteOutput(paneId) {
      const entry = activityOf(paneId);
      const now = Date.now();
      // Echo, a repaint after a resize, or a launch banner: the terminal is
      // answering something, not doing work on its own.
      const reply =
        now - entry.lastInput < REPLY_MS ||
        now - entry.lastResize < REPLY_MS ||
        now - entry.spawnedAt < STARTUP_MS;
      if (entry.runStart === null && !reply) entry.runStart = now;
      entry.lastOutput = now;
    },

    noteActivity(paneId, kind) {
      const entry = activityOf(paneId);
      const now = Date.now();

      if (kind === "spawn") {
        entry.spawnedAt = now;
        entry.runStart = null;
        // A fresh process starts with a clean slate: not dead, not done.
        set((state) => {
          if (!(paneId in state.exited) && !(paneId in state.status)) {
            return state;
          }
          const exited = { ...state.exited };
          delete exited[paneId];
          const status = { ...state.status };
          delete status[paneId];
          return { exited, status };
        });
        return;
      }

      if (kind === "resize") {
        entry.lastResize = now;
        return;
      }

      entry.lastInput = now;
      // Typing breaks up a burst of echo that would otherwise pass for work —
      // unless the agent is already working, which typing does not stop.
      if (get().status[paneId] !== "working") entry.runStart = null;
      acknowledge(paneId);
    },

    notePaneExit(paneId) {
      activity.delete(paneId);
      set((state) => ({
        exited: { ...state.exited, [paneId]: true },
        status: { ...state.status, [paneId]: "idle" },
      }));
    },
  };
});

/**
 * Agent status tracking. One timer for the whole app derives every pane's status
 * from output timing, and only writes to the store when something changed.
 *
 * idle → working once an agent has produced unprompted output for a sustained
 * stretch; working → done once it has gone quiet; done → idle when you focus or
 * type into it. Plain shells and exited panes stay idle.
 */
export function startAttentionTracking(): () => void {
  const timer = setInterval(() => {
    const state = useKeel.getState();
    const next: Record<string, PaneStatus> = {};
    let changed = false;

    const now = Date.now();

    for (const project of state.projects) {
      for (const deck of project.decks) {
        for (const [paneId, pane] of Object.entries(deck.panes)) {
          const previous = state.status[paneId] ?? "idle";
          const entry = activity.get(paneId);
          let current: PaneStatus = "idle";

          if (pane.agentId !== null && entry && !(paneId in state.exited)) {
            if (entry.runStart !== null && now - entry.lastOutput >= QUIET_MS) {
              entry.runStart = null;
            }
            const sustained =
              entry.runStart !== null &&
              entry.lastOutput - entry.runStart >= MIN_RUN_MS;
            if (sustained || (previous === "working" && entry.runStart !== null)) {
              current = "working";
            } else if (previous === "working") {
              current = "done";
            } else {
              current = previous;
            }
          }

          next[paneId] = current;
          if (current !== previous) changed = true;
        }
      }
    }

    if (
      changed ||
      Object.keys(next).length !== Object.keys(state.status).length
    ) {
      useKeel.setState({ status: next });
    }
  }, 350);

  return () => clearInterval(timer);
}

