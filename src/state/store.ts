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

import * as backend from "../lib/backend.ts";
import type { DropZone } from "../lib/dock.ts";
import { lookingAt, waitingPanes } from "../lib/island.ts";
import {
  readKeybindingOverrides,
  setKeybindingOverrides,
  withOverride,
  withoutOverride,
  type Binding,
  type KeybindingOverrides,
  type ShortcutId,
} from "../lib/keymap.ts";
import { pickCapturedSession, unboundSession } from "../lib/launch.ts";
import {
  briefFromOsc,
  briefFromPrompt,
  isGenericLabel,
  type TitleSource,
} from "../lib/paneTitle.ts";
import { editorRefId, editorRefName } from "../lib/editorRefs.ts";
import { moveTo } from "../lib/order.ts";
import { killPty } from "../lib/pty.ts";
import {
  balance,
  besideTree,
  closePane as closeInTree,
  dockAtEdge,
  dockPane,
  gridOf,
  listPanes,
  movePane as moveInTree,
  neighbourPane,
  paneLeaf,
  relabelPanes,
  resizeSplit,
  splitPane,
  swapPanes,
  type MoveDirection,
} from "../lib/tree.ts";
import type {
  Agent,
  AgentAccount,
  AgentSpec,
  Deck,
  Direction,
  EditorRef,
  Pane,
  PaneActivity,
  PaneEditor,
  PaneStatus,
  PersistedState,
  Project,
  SidebarRoot,
  VpnSettings,
  VpnState,
  Workspace,
} from "../lib/types.ts";
import {
  dissolveWorkspace as dissolveWorkspaceLayout,
  emptyWorkspace,
  forgetProject,
  insertWorkspace,
  nextWorkspaceName,
  normalizeWorkspaces,
  placeProject,
  rememberWorkspaceProject,
  renameWorkspace as renameWorkspaceList,
  reorderRoot,
  repairSidebar,
  rootIndexOfProject,
  setWorkspaceCollapsed,
  shiftMember,
  shiftRoot,
  workspaceOf,
  type Layout,
} from "../lib/workspaces.ts";

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
  kind: "workspace" | "project" | "deck" | "pane";
  id: string;
  /** A pane's name shows in both the sidebar and its own header. */
  where: "sidebar" | "pane";
}

/** What a caller needs to describe a terminal it wants opened. */
export interface PaneSpec {
  agentId: string | null;
  /** Left out, the agent's chosen profile for new terminals is used. */
  accountId?: string | null;
  cwd?: string | null;
  title?: string;
}

export interface KeelState {
  ready: boolean;
  agents: Agent[];
  accounts: AgentAccount[];
  projects: Project[];
  workspaces: Workspace[];
  /** Top-level sidebar order: workspaces mixed with ungrouped projects. */
  sidebar: SidebarRoot[];
  activeProjectId: string | null;
  /** Recomputed on a timer from output timing, never written to disk. */
  status: Record<string, PaneStatus>;
  /** Panes whose shell has exited. Not persisted. */
  exited: Record<string, true>;
  /** Panes playing their exit before they are removed. Not persisted. */
  closing: Record<string, true>;
  /** Session reopen chrome — not persisted. */
  restoreStatus: RestoreStatus;
  /** Panes still settling after a layout reopen. */
  restoreLeft: number;
  /** Panes that existed when the app opened. New chats are not in here. */
  restorePanes: Record<string, true>;
  /** Host IPC looks dead (UI banner). Not persisted. */
  hostLost: boolean;

  /** Private OpenVPN tunnel. Only autoConnect/connectOnLaunch/profileId are persisted. */
  vpn: VpnState;
  refreshVpn: () => Promise<void>;
  connectVpn: (profileId?: string | null) => Promise<void>;
  disconnectVpn: () => Promise<void>;
  setVpnAutoConnect: (autoConnect: boolean) => void;
  setVpnProfile: (profileId: string | null) => void;
  openVpnSettings: () => void;
  closeVpnSettings: () => void;

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
  /** Which profile new terminals of this agent start on; null is the CLI's own sign-in. */
  setDefaultAccount: (agentId: string, accountId: string | null) => void;
  /** Panes signed in with it fall back to the default login and restart. */
  removeAccount: (accountId: string) => void;
  /** Replace the agent catalogue on disk and re-detect. Rejects invalid input. */
  saveAgents: (agents: AgentSpec[]) => Promise<void>;

  /** Bumped to respawn a pane's process in the same terminal. Not persisted. */
  generations: Record<string, number>;
  restartPane: (paneId: string) => void;
  /** Agent process left the shell; the next spawn should not type the command. */
  releaseAgent: (paneId: string) => void;
  /** First successful spawn: later launches should resume this conversation. */
  markSessionReady: (paneId: string) => void;
  /** Bind this pane to the conversation that actually started in it. */
  bindSession: (paneId: string, sessionId: string) => void;
  /** After the agent process appears, record its real conversation id. */
  captureSession: (paneId: string) => Promise<void>;

  /** The agents & profiles dialog; `agentId` preselects an agent. */
  agentSettings: { open: boolean; agentId: string | null };
  openAgentSettings: (agentId?: string | null) => void;
  closeAgentSettings: () => void;

  /** The Add terminals dialog. */
  launcher: boolean;
  setLauncher: (open: boolean) => void;

  /** When each finished pane finished, for ordering what is waiting. Not persisted. */
  doneAt: Record<string, number>;
  /** The go-to switcher that drops out of the top bar's island. */
  switcher: boolean;
  setSwitcher: (open: boolean) => void;
  /** Which top-bar menu is open ("project", "go", …), or "" for none. */
  menubar: string;
  setMenubar: (value: string) => void;
  /** Bumped when a jump finds nothing waiting, so the island can say so. */
  islandNudge: number;
  /** Bring a pane forward wherever it lives: its project, its deck, focus. */
  jumpToPane: (paneId: string) => boolean;
  /** Go to the agent that has been waiting longest. Returns its pane, if any. */
  jumpToNextWaiting: () => string | null;

  /** Shortcuts you changed. Applied to `keymap` and written to disk. */
  keybindings: KeybindingOverrides;
  /**
   * Give an action a chord, or none. Actions in `displace` lose theirs, for
   * when the chord was taken and you chose to move it.
   */
  setKeybinding: (
    id: ShortcutId,
    binding: Binding | null,
    displace?: ShortcutId[],
  ) => void;
  resetKeybinding: (id: ShortcutId) => void;
  resetKeybindings: () => void;

  /** Which name is being edited in place, if any. */
  renaming: RenameTarget | null;
  startRename: (target: RenameTarget) => void;
  stopRename: () => void;

  renameProject: (projectId: string, name: string) => void;
  renameWorkspace: (workspaceId: string, name: string) => void;
  renamePane: (projectId: string, paneId: string, title: string) => void;
  /**
   * Rename a pane from what the agent is doing. No-ops if you have named it
   * yourself. OSC titles only apply while the pane still has its factory name.
   */
  autoTitlePane: (paneId: string, raw: string, source: TitleSource) => void;
  /** Shift a project one place among its neighbours — members, or top-level. */
  moveProject: (projectId: string, delta: -1 | 1) => void;
  /** Shift a workspace one place among the top-level sidebar rows. */
  moveWorkspace: (workspaceId: string, delta: -1 | 1) => void;
  /** Shift a deck one place; its number follows its position. */
  moveDeck: (projectId: string, deckId: string, delta: -1 | 1) => void;
  /**
   * Put a standalone project at `index` among the top-level rows, counted
   * without it. Nested projects use `placeProjectIn`.
   */
  reorderProject: (projectId: string, index: number) => void;
  /** Put a workspace at `index` among the top-level rows, counted without it. */
  reorderWorkspace: (workspaceId: string, index: number) => void;
  /**
   * Move a project to a top-level slot or into a workspace. Covers join, leave,
   * and reorder with one call.
   */
  placeProjectIn: (
    projectId: string,
    dest:
      | { kind: "root"; index: number }
      | { kind: "member"; workspaceId: string; index: number },
  ) => void;
  /** Put a deck at `index` among its project's decks, counted without it. */
  reorderDeck: (projectId: string, deckId: string, index: number) => void;
  /**
   * Put a terminal at `index` in a deck's reading order, carrying it over from
   * another deck of the same project first. The layout keeps its shape;
   * terminals trade places inside it.
   */
  placePane: (
    projectId: string,
    paneId: string,
    deckId: string,
    index: number,
  ) => void;
  setAllCollapsed: (collapsed: boolean) => void;

  addProject: (path: string, name?: string, workspaceId?: string) => Project;
  removeProject: (projectId: string) => void;
  /** Selection only ever moves to another project; it is never cleared. */
  selectProject: (projectId: string) => void;
  toggleCollapsed: (projectId: string) => void;

  /**
   * Create a workspace. Pass a project to start with that member inside it.
   * Starts an in-place rename so the placeholder name is only a moment.
   */
  addWorkspace: (projectId?: string) => string;
  /** Ungroup. Member projects become standalone; they are not deleted. */
  dissolveWorkspace: (workspaceId: string) => void;
  selectWorkspace: (workspaceId: string) => void;
  toggleWorkspaceCollapsed: (workspaceId: string) => void;

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
  /**
   * Close from the UI: a pane on screen shrinks away first, then `closePane`
   * removes it. Anything off screen closes at once.
   */
  dismissPane: (projectId: string, paneId: string) => void;
  /**
   * Show a file or diff on the active deck: in the editor pane already holding
   * it, else the focused editor pane, else any editor pane — or a new one
   * standing along the right edge of the layout.
   */
  openInEditor: (projectId: string, ref: EditorRef) => void;
  selectEditorTab: (projectId: string, paneId: string, tabId: string) => void;
  /** Take a tab out of its pane. The pane closes with its last tab. */
  closeEditorTab: (projectId: string, paneId: string, tabId: string) => void;
  /**
   * Rewrite the tabs of every editor pane in a folder's projects: return the
   * tab moved, `null` to drop it, or the same object to leave it. Panes left
   * with nothing to show close.
   */
  rewriteEditorTabs: (
    projectPath: string,
    change: (ref: EditorRef) => EditorRef | null,
  ) => void;
  focusPane: (projectId: string, paneId: string) => void;
  cyclePane: (projectId: string, step: 1 | -1) => void;
  movePane: (
    projectId: string,
    paneId: string,
    direction: MoveDirection,
  ) => void;
  /**
   * Drag and drop. An edge zone docks the pane against its target — a pane, a
   * group of panes, or the whole layout — and the middle swaps two panes.
   */
  dropPane: (
    projectId: string,
    paneId: string,
    /** A pane id, or a split id. */
    targetId: string,
    zone: DropZone,
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

/** How long a closing pane takes to shrink away. Matches `k-pane-out`. */
const PANE_EXIT_MS = 170;

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function defaultTitle(agents: Agent[], agentId: string | null): string {
  if (!agentId) return "Shell";
  return agents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

/** An editor pane with nothing in it yet. */
function blankEditorPane(paneId: string): Pane {
  return {
    id: paneId,
    agentId: null,
    accountId: null,
    resumeAgent: false,
    ...unboundSession(),
    title: "Editor",
    cwd: null,
    editor: { tabs: [], active: null },
  };
}

/** An editor pane showing `active` among `tabs`, named after what it shows. */
function showTab(pane: Pane, tabs: EditorRef[], active: string | null): Pane {
  const shown = tabs.find((tab) => editorRefId(tab) === active) ?? tabs[0];
  return {
    ...pane,
    editor: { tabs, active: shown ? editorRefId(shown) : null },
    title: pane.titleLocked || !shown ? pane.title : editorRefName(shown),
  };
}

function normalizeEditor(editor: PaneEditor): PaneEditor {
  const tabs = (Array.isArray(editor.tabs) ? editor.tabs : [])
    .filter(
      (tab) =>
        tab &&
        typeof tab.rel === "string" &&
        (tab.kind === "file" || tab.kind === "diff"),
    )
    .map((tab) => ({ kind: tab.kind, rel: tab.rel, staged: tab.staged === true }));
  const ids = tabs.map(editorRefId);
  return {
    tabs,
    active:
      editor.active && ids.includes(editor.active) ? editor.active : (ids[0] ?? null),
  };
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
  return Object.keys(paneIdsOf(projects)).length;
}

/** Every terminal — the panes a reopen waits on. Editor panes start nothing. */
function paneIdsOf(projects: Project[]): Record<string, true> {
  const ids: Record<string, true> = {};
  for (const project of projects) {
    for (const deck of project.decks) {
      for (const [paneId, pane] of Object.entries(deck.panes)) {
        if (pane.editor) continue;
        ids[paneId] = true;
      }
    }
  }
  return ids;
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
          {
            ...pane,
            accountId: pane.accountId ?? null,
            resumeAgent: pane.resumeAgent ?? pane.agentId !== null,
            sessionId: pane.sessionId ?? null,
            sessionReady: pane.sessionReady ?? false,
            ...(pane.editor ? { editor: normalizeEditor(pane.editor) } : {}),
          },
        ]),
      ),
    })),
  }));
}

export const DEFAULT_VPN: VpnSettings = {
  autoConnect: false,
  profileId: null,
};

function readVpn(document: Record<string, unknown> | null): VpnSettings {
  const raw = document?.vpn;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_VPN };
  const vpn = raw as Record<string, unknown>;
  return {
    autoConnect: vpn.connectOnLaunch === true,
    profileId: typeof vpn.profileId === "string" && vpn.profileId.trim()
      ? vpn.profileId
      : null,
  };
}

function vpnFromSnapshot(
  previous: VpnState,
  snapshot: backend.VpnSnapshot,
  spawnAllowed: boolean,
): VpnState {
  const phase =
    snapshot.phase === "connecting" ||
    snapshot.phase === "connected" ||
    snapshot.phase === "error"
      ? snapshot.phase
      : "idle";
  return {
    ...previous,
    phase,
    spawnAllowed,
    connectInstalled: snapshot.connectInstalled,
    openvpnPath: snapshot.openvpnPath,
    profiles: snapshot.profiles,
    profileId: snapshot.profileId ?? previous.profileId,
    profileName: snapshot.profileName,
    adapter: snapshot.adapter,
    tunnelIp: snapshot.tunnelIp,
    proxyPort: snapshot.proxyPort,
    isolated: snapshot.isolated,
    error: snapshot.error,
  };
}

function emptyVpn(settings: VpnSettings): VpnState {
  return {
    autoConnect: settings.autoConnect,
    profileId: settings.profileId,
    phase: settings.autoConnect ? "connecting" : "idle",
    spawnAllowed: !settings.autoConnect,
    connectInstalled: false,
    openvpnPath: null,
    profiles: [],
    profileName: null,
    adapter: null,
    tunnelIp: null,
    proxyPort: null,
    isolated: true,
    error: null,
    dialogOpen: false,
  };
}

/**
 * The profile a new terminal starts on. A spec that names one — even null, the
 * CLI's own sign-in — keeps it; otherwise the agent's chosen profile, if any.
 */
function accountFor(spec: PaneSpec, accounts: AgentAccount[]): string | null {
  if (spec.accountId !== undefined) return spec.accountId;
  if (!spec.agentId) return null;
  return (
    accounts.find(
      (account) => account.agentId === spec.agentId && account.isDefault,
    )?.id ?? null
  );
}

function isDocumentVersion(version: unknown): version is 3 | 4 | 5 {
  return version === 3 || version === 4 || version === 5;
}

function readAccounts(document: Record<string, unknown> | null): AgentAccount[] {
  if (
    !document ||
    (document.version !== 4 && document.version !== 5) ||
    !Array.isArray(document.accounts)
  ) {
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
        ...(account.isDefault === true ? { isDefault: true } : {}),
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
  let vpnConnecting = false;
  let vpnRevision = 0;

  /** Debounced write-through. Every mutation calls this; disk sees one write. */
  function persist(immediate = false) {
    if (!get().ready) return;
    if (saveTimer) clearTimeout(saveTimer);
    const write = () => {
      saveTimer = null;
      const { projects, workspaces, sidebar, activeProjectId, accounts, vpn, keybindings } =
        get();
      const projectIds = new Set(projects.map((project) => project.id));
      const cleaned = normalizeWorkspaces(workspaces, projectIds);
      const document: PersistedState = {
        version: 5,
        projects,
        workspaces: cleaned,
        sidebar: repairSidebar(projects, cleaned, sidebar),
        activeProjectId,
        accounts,
        vpn: {
          autoConnect: vpn.autoConnect,
          connectOnLaunch: vpn.autoConnect,
          profileId: vpn.profileId,
        },
        keybindings,
      };
      void backend.saveState(document).catch(() => {
        /* A failed save should never interrupt what the user is doing. */
      });
    };
    if (immediate) write();
    else saveTimer = setTimeout(write, 400);
  }

  /** Saved order, with missing rows filled in so tests and old documents still work. */
  function layoutOf(state = get()): Layout {
    const projectIds = new Set(state.projects.map((project) => project.id));
    const workspaces = normalizeWorkspaces(state.workspaces, projectIds);
    return {
      workspaces,
      sidebar: repairSidebar(state.projects, workspaces, state.sidebar),
    };
  }

  function patchLayout(change: (layout: Layout) => Layout) {
    const next = change(layoutOf());
    set({ workspaces: next.workspaces, sidebar: next.sidebar });
    persist();
  }

  function findPane(paneId: string): Pane | null {
    for (const project of get().projects) {
      const pane = deckOfPane(project, paneId)?.panes[paneId];
      if (pane) return pane;
    }
    return null;
  }

  /** Conversations already owned by another pane of the same agent/account. */
  function claimedSessionIds(paneId: string, pane: Pane): Set<string> {
    const claimed = new Set<string>();
    for (const item of get().projects) {
      for (const deck of item.decks) {
        for (const [id, other] of Object.entries(deck.panes)) {
          if (id === paneId || !other.sessionReady || !other.sessionId) continue;
          if (other.agentId !== pane.agentId) continue;
          if ((other.accountId ?? null) !== (pane.accountId ?? null)) continue;
          claimed.add(other.sessionId);
        }
      }
    }
    return claimed;
  }

  /** Edit whichever deck holds `paneId`, searching every project. */
  function patchPane(
    paneId: string,
    change: (pane: Pane) => Pane,
    immediate = false,
  ) {
    const state = get();
    for (const project of state.projects) {
      const deck = deckOfPane(project, paneId);
      if (!deck || !deck.panes[paneId]) continue;
      updateDeck(project.id, deck.id, (current) => ({
        ...current,
        panes: {
          ...current.panes,
          [paneId]: change(current.panes[paneId]),
        },
      }));
      if (immediate) persist(true);
      return;
    }
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
    workspaces: [],
    sidebar: [],
    activeProjectId: null,
    status: {},
    exited: {},
    closing: {},
    generations: {},
    agentSettings: { open: false, agentId: null },
    launcher: false,
    doneAt: {},
    keybindings: {},
    switcher: false,
    menubar: "",
    islandNudge: 0,
    renaming: null,
    restoreStatus: "idle",
    restoreLeft: 0,
    restorePanes: {},
    hostLost: false,
    vpn: emptyVpn(DEFAULT_VPN),

    async init() {
      restoreSettled.clear();
      const existing = countPanes(get().projects);
      set({
        restoreStatus: existing > 0 ? "restoring" : "idle",
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
          workspaces: [],
          sidebar: [],
          activeProjectId: null,
          vpn: { ...emptyVpn(DEFAULT_VPN), spawnAllowed: true, phase: "idle" },
          ready: true,
          restoreStatus: "failed",
          restoreLeft: 0,
          restorePanes: {},
          status: {},
          exited: {},
        });
        return;
      }

      const document = saved as unknown as Record<string, unknown> | null;
      const projects = normalizeProjects(
        document && isDocumentVersion(document.version)
          ? ((document.projects as Project[]) ?? [])
          : migrate(document),
      );
      const projectIds = new Set(projects.map((project) => project.id));
      const workspaces = normalizeWorkspaces(document?.workspaces, projectIds);
      const sidebar = repairSidebar(projects, workspaces, document?.sidebar);
      const accounts = readAccounts(document);
      const vpnSettings = readVpn(document);
      // Before anything renders a label or a key reaches a terminal.
      const keybindings = readKeybindingOverrides(document?.keybindings);
      setKeybindingOverrides(keybindings);

      const wanted = document?.activeProjectId as string | null | undefined;
      const activeProjectId =
        wanted && projects.some((project) => project.id === wanted)
          ? wanted
          : (projects[0]?.id ?? null);

      const restorePanes = paneIdsOf(projects);
      const paneCount = Object.keys(restorePanes).length;
      set({
        agents,
        accounts,
        projects,
        workspaces,
        sidebar,
        activeProjectId,
        ready: true,
        restoreStatus: paneCount > 0 ? "restoring" : "idle",
        restoreLeft: paneCount,
        restorePanes,
        status: {},
        exited: {},
        vpn: emptyVpn(vpnSettings),
        keybindings,
      });
      persist(true);
      if (vpnSettings.autoConnect) {
        void get().connectVpn(vpnSettings.profileId);
      } else {
        void get().refreshVpn();
      }

      // Each pane settles after its actual spawn attempt. VPN startup can take
      // longer than eight seconds; a timer must not report those panes restored.
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
        workspaces: [],
        sidebar: [],
        activeProjectId: null,
        status: {},
        exited: {},
        restoreStatus: "idle",
        restoreLeft: 0,
        restorePanes: {},
        ready: true,
      });
      persist();
    },

    settleRestore(paneId, ok) {
      if (!ok) get().notePaneExit(paneId);

      const state = get();
      if (state.restoreStatus !== "restoring") return;
      // A pane opened after startup is a new chat, not part of power-up restore.
      if (!(paneId in state.restorePanes)) return;
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
          [paneId]: {
            ...current.panes[paneId],
            accountId,
            // A different login has its own session store.
            ...unboundSession(),
          },
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

    setDefaultAccount(agentId, accountId) {
      set((state) => ({
        accounts: state.accounts.map((account) => {
          if (account.agentId !== agentId) return account;
          const { isDefault: _previous, ...rest } = account;
          return account.id === accountId ? { ...rest, isDefault: true } : rest;
        }),
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
                return [
                  id,
                  {
                    ...pane,
                    accountId: null,
                    ...unboundSession(),
                  },
                ];
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
      const pane = findPane(paneId);
      if (pane?.agentId && !pane.resumeAgent) {
        patchPane(paneId, (current) => ({ ...current, resumeAgent: true }), true);
      }
      set((state) => ({
        generations: {
          ...state.generations,
          [paneId]: (state.generations[paneId] ?? 0) + 1,
        },
      }));
    },

    releaseAgent(paneId) {
      const pane = findPane(paneId);
      if (!pane?.agentId || !pane.resumeAgent) return;
      patchPane(paneId, (current) => ({ ...current, resumeAgent: false }), true);
    },

    markSessionReady(_paneId) {
      // Spawn chrome only. sessionReady becomes true only when captureSession
      // binds the conversation this process created — not merely because the
      // executable started.
    },

    bindSession(paneId, sessionId) {
      const pane = findPane(paneId);
      if (!pane) return;
      if (pane.sessionId === sessionId && pane.sessionReady) return;
      patchPane(
        paneId,
        (current) => ({ ...current, sessionId, sessionReady: true }),
        true,
      );
    },

    async captureSession(paneId) {
      const pane = findPane(paneId);
      if (!pane?.agentId || !pane.resumeAgent) return;
      // Already bound to a real conversation. Restarting this pane resumes
      // that id; do not adopt a different transcript from the folder.
      if (pane.sessionReady) return;
      const project = get().projects.find((item) => deckOfPane(item, paneId));
      if (!project) return;
      const agent = get().agents.find((entry) => entry.id === pane.agentId);
      const store = agent?.session?.store;
      if (store !== "grok" && store !== "claude") return;

      const spawnedAt = activity.get(paneId)?.spawnedAt ?? Date.now();

      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        const live = findPane(paneId);
        if (!live?.resumeAgent) return;
        if (live.sessionReady) return;
        // A restart while we were waiting belongs to a later capture.
        if ((activity.get(paneId)?.spawnedAt ?? spawnedAt) !== spawnedAt) return;

        const recent = await backend
          .sessionRecent({
            store,
            cwd: live.cwd ?? project.path,
            accountEnv: agent?.accountEnv ?? null,
            accountId: live.accountId,
          })
          .catch(() => [] as { id: string; mtimeMs: number }[]);

        const captured = pickCapturedSession({
          // Never wait for a leftover generated UUID. Fresh launches do not
          // pass `--session-id`, so the process creates its own conversation.
          mintedId: null,
          recent,
          claimed: claimedSessionIds(paneId, live),
          spawnedAt,
        });
        if (captured) {
          get().bindSession(paneId, captured);
          return;
        }
      }
    },

    openAgentSettings(agentId = null) {
      set({ agentSettings: { open: true, agentId } });
    },

    closeAgentSettings() {
      set((state) => ({
        agentSettings: { ...state.agentSettings, open: false },
      }));
    },

    openVpnSettings() {
      set((state) => ({ vpn: { ...state.vpn, dialogOpen: true } }));
      void get().refreshVpn();
    },

    closeVpnSettings() {
      set((state) => ({ vpn: { ...state.vpn, dialogOpen: false } }));
    },

    async refreshVpn() {
      const revision = vpnRevision;
      try {
        const snapshot = await backend.vpnSnapshot();
        if (revision !== vpnRevision) return;
        set((state) => ({
          vpn: {
            ...vpnFromSnapshot(state.vpn, snapshot, state.vpn.spawnAllowed),
            // Discovery may finish before the connection command starts.
            ...(vpnConnecting ? { phase: "connecting" as const, error: null } : {}),
          },
        }));
      } catch {
        /* Discovery failing must not brick the session. */
      }
    },

    async connectVpn(profileId) {
      if (vpnConnecting) return;
      vpnConnecting = true;
      vpnRevision += 1;
      const chosen = profileId ?? get().vpn.profileId;
      set((state) => ({
        vpn: {
          ...state.vpn,
          profileId: chosen ?? state.vpn.profileId,
          phase: "connecting",
          spawnAllowed: false,
          error: null,
        },
      }));
      persist();
      try {
        const snapshot = await backend.vpnConnect(chosen);
        set((state) => ({
          vpn: vpnFromSnapshot(
            {
              ...state.vpn,
              profileId: chosen ?? state.vpn.profileId,
            },
            snapshot,
            true,
          ),
        }));
      } catch (error) {
        set((state) => ({
          vpn: {
            ...state.vpn,
            phase: "error",
            spawnAllowed: true,
            error: String(error),
          },
        }));
      } finally {
        vpnConnecting = false;
        vpnRevision += 1;
      }
    },

    async disconnectVpn() {
      if (vpnConnecting) return;
      vpnRevision += 1;
      try {
        const snapshot = await backend.vpnDisconnect();
        set((state) => ({
          vpn: vpnFromSnapshot(state.vpn, snapshot, true),
        }));
      } catch (error) {
        set((state) => ({
          vpn: {
            ...state.vpn,
            phase: "error",
            spawnAllowed: true,
            error: String(error),
          },
        }));
      } finally {
        vpnRevision += 1;
      }
    },

    setVpnAutoConnect(autoConnect) {
      set((state) => ({ vpn: { ...state.vpn, autoConnect } }));
      persist();
      if (autoConnect && get().vpn.phase !== "connected") {
        void get().connectVpn();
      }
    },

    setVpnProfile(profileId) {
      set((state) => ({ vpn: { ...state.vpn, profileId } }));
      persist();
    },

    setLauncher(open) {
      set({ launcher: open });
    },

    setSwitcher(open) {
      set({ switcher: open });
    },

    setMenubar(value) {
      set({ menubar: value });
    },

    setKeybinding(id, binding, displace = []) {
      let keybindings = withOverride(get().keybindings, id, binding);
      for (const other of displace) {
        if (other !== id) keybindings = withOverride(keybindings, other, null);
      }
      setKeybindingOverrides(keybindings);
      set({ keybindings });
      persist();
    },

    resetKeybinding(id) {
      const keybindings = withoutOverride(get().keybindings, id);
      setKeybindingOverrides(keybindings);
      set({ keybindings });
      persist();
    },

    resetKeybindings() {
      setKeybindingOverrides({});
      set({ keybindings: {} });
      persist();
    },

    jumpToPane(paneId) {
      const project = get().projects.find((item) => deckOfPane(item, paneId));
      const deck = project ? deckOfPane(project, paneId) : null;
      if (!project || !deck) return false;
      acknowledge(paneId);
      set({ activeProjectId: project.id });
      updateProject(project.id, (current) => ({
        ...current,
        // Open in the sidebar too, so the row you just went to is on screen.
        collapsed: false,
        activeDeckId: deck.id,
        decks: current.decks.map((item) =>
          item.id === deck.id
            ? {
                ...item,
                focused: paneId,
                // A different pane filling the deck would hide the one you asked for.
                zoomed: item.zoomed === paneId ? item.zoomed : null,
              }
            : item,
        ),
      }));
      return true;
    },

    jumpToNextWaiting() {
      const state = get();
      const next = waitingPanes(
        state.projects,
        state.status,
        state.doneAt,
        lookingAt(state.projects, state.activeProjectId),
      )[0];
      if (!next) {
        set({ islandNudge: state.islandNudge + 1 });
        return null;
      }
      get().jumpToPane(next.paneId);
      return next.paneId;
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

    renameWorkspace(workspaceId, name) {
      const clean = name.trim();
      if (!clean) return;
      set((state) => ({
        workspaces: renameWorkspaceList(state.workspaces, workspaceId, clean),
      }));
      persist();
    },

    renamePane(projectId, paneId, title) {
      const clean = title.trim();
      if (!clean) return;
      updateDeckOfPane(projectId, paneId, (deck) => ({
        ...deck,
        panes: {
          ...deck.panes,
          [paneId]: {
            ...deck.panes[paneId],
            title: clean,
            titleLocked: true,
          },
        },
      }));
    },

    autoTitlePane(paneId, raw, source) {
      const state = get();
      for (const project of state.projects) {
        const deck = deckOfPane(project, paneId);
        const pane = deck?.panes[paneId];
        if (!pane) continue;
        if (pane.titleLocked || !pane.agentId) return;

        const agent =
          state.agents.find((entry) => entry.id === pane.agentId) ?? null;
        const brief =
          source === "prompt"
            ? briefFromPrompt(raw)
            : briefFromOsc(raw, agent);
        if (!brief) return;
        // OSC is often the program name or a path. A prompt is the work; once
        // we have one, later OSC updates would only make the title noisier.
        if (source === "osc" && !isGenericLabel(pane.title, agent)) return;
        if (pane.title === brief) return;

        patchPane(paneId, (current) => ({ ...current, title: brief }));
        return;
      }
    },

    moveProject(projectId, delta) {
      const { workspaces, sidebar } = layoutOf();
      const group = workspaceOf(workspaces, projectId);
      if (group) {
        set({ workspaces: shiftMember(workspaces, group.id, projectId, delta) });
      } else {
        set({
          sidebar: shiftRoot(sidebar, { kind: "project", id: projectId }, delta),
        });
      }
      persist();
    },

    moveWorkspace(workspaceId, delta) {
      const { sidebar } = layoutOf();
      set({
        sidebar: shiftRoot(sidebar, { kind: "workspace", id: workspaceId }, delta),
      });
      persist();
    },

    moveDeck(projectId, deckId, delta) {
      updateProject(projectId, (project) => ({
        ...project,
        decks: shift(project.decks, (deck) => deck.id === deckId, delta),
      }));
    },

    reorderProject(projectId, index) {
      get().placeProjectIn(projectId, { kind: "root", index });
    },

    reorderWorkspace(workspaceId, index) {
      const { sidebar } = layoutOf();
      set({
        sidebar: reorderRoot(sidebar, { kind: "workspace", id: workspaceId }, index),
      });
      persist();
    },

    placeProjectIn(projectId, dest) {
      if (!get().projects.some((project) => project.id === projectId)) return;
      if (dest.kind === "member") {
        const { workspaces } = layoutOf();
        if (!workspaces.some((item) => item.id === dest.workspaceId)) return;
      }
      patchLayout((layout) =>
        placeProject(layout.workspaces, layout.sidebar, projectId, dest),
      );
    },

    reorderDeck(projectId, deckId, index) {
      updateProject(projectId, (project) => ({
        ...project,
        decks: moveTo(project.decks, (deck) => deck.id === deckId, index),
      }));
    },

    placePane(projectId, paneId, deckId, index) {
      const project = get().projects.find((item) => item.id === projectId);
      const from = project ? deckOfPane(project, paneId) : null;
      if (!project || !from) return;
      if (!project.decks.some((deck) => deck.id === deckId)) return;

      if (from.id !== deckId) get().movePaneToDeck(projectId, paneId, deckId);
      updateDeck(projectId, deckId, (deck) => {
        if (!deck.tree) return deck;
        const order = listPanes(deck.tree).filter((id) => id !== paneId);
        order.splice(Math.max(0, Math.min(index, order.length)), 0, paneId);
        return { ...deck, tree: relabelPanes(deck.tree, order) };
      });
    },

    setAllCollapsed(collapsed) {
      set((state) => ({
        projects: state.projects.map((project) => ({ ...project, collapsed })),
        workspaces: state.workspaces.map((workspace) => ({
          ...workspace,
          collapsed,
        })),
      }));
      persist();
    },

    addProject(path, name, workspaceId) {
      const existing = get().projects.find((project) => project.path === path);
      if (existing) {
        if (workspaceId) {
          const { workspaces } = layoutOf();
          const workspace = workspaces.find((item) => item.id === workspaceId);
          if (workspace) {
            get().placeProjectIn(existing.id, {
              kind: "member",
              workspaceId,
              index: workspace.projectIds.length,
            });
          }
        }
        get().selectProject(existing.id);
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
      const { workspaces, sidebar } = layoutOf();
      const dest = workspaceId
        ? workspaces.find((item) => item.id === workspaceId)
        : null;
      const placed = dest
        ? placeProject(workspaces, sidebar, project.id, {
            kind: "member",
            workspaceId: dest.id,
            index: dest.projectIds.length,
          })
        : {
            workspaces,
            sidebar: [...sidebar, { kind: "project" as const, id: project.id }],
          };
      set({
        projects: [...get().projects, project],
        workspaces: dest
          ? rememberWorkspaceProject(placed.workspaces, dest.id, project.id)
          : placed.workspaces,
        sidebar: placed.sidebar,
        activeProjectId: project.id,
      });
      persist();
      return project;
    },

    removeProject(projectId) {
      const project = get().projects.find((item) => item.id === projectId);
      // The terminals only existed inside this project; take them with it.
      for (const deck of project?.decks ?? []) {
        for (const paneId of Object.keys(deck.panes)) {
          get().settleRestore(paneId, true);
          void killPty(paneId).catch(() => {});
          activity.delete(paneId);
        }
      }
      const { workspaces, sidebar } = layoutOf();
      const group = workspaceOf(workspaces, projectId);
      const neighbour =
        group?.projectIds.find((id) => id !== projectId) ?? null;
      const forgotten = forgetProject(workspaces, sidebar, projectId);
      const projects = get().projects.filter((item) => item.id !== projectId);
      const nextActive =
        get().activeProjectId === projectId
          ? (neighbour && projects.some((item) => item.id === neighbour)
              ? neighbour
              : (projects[0]?.id ?? null))
          : get().activeProjectId;
      set({
        projects,
        workspaces: forgotten.workspaces,
        sidebar: forgotten.sidebar,
        activeProjectId: nextActive,
      });
      persist();
    },

    selectProject(projectId) {
      // Deliberately one-way: picking a project never unpicks the current one.
      if (!get().projects.some((project) => project.id === projectId)) return;
      const { workspaces } = layoutOf();
      const group = workspaceOf(workspaces, projectId);
      set({
        activeProjectId: projectId,
        workspaces: group
          ? rememberWorkspaceProject(workspaces, group.id, projectId)
          : workspaces,
      });
      persist();
    },

    addWorkspace(projectId) {
      const { workspaces, sidebar } = layoutOf();
      const workspace = emptyWorkspace(
        makeId("wks"),
        nextWorkspaceName(workspaces),
      );
      const after = projectId
        ? rootIndexOfProject(workspaces, sidebar, projectId)
        : get().activeProjectId
          ? rootIndexOfProject(workspaces, sidebar, get().activeProjectId!)
          : sidebar.length - 1;
      const index = after >= 0 ? after + 1 : sidebar.length;
      let next = insertWorkspace(workspaces, sidebar, workspace, index);
      if (projectId && get().projects.some((item) => item.id === projectId)) {
        next = placeProject(next.workspaces, next.sidebar, projectId, {
          kind: "member",
          workspaceId: workspace.id,
          index: 0,
        });
      }
      set({
        workspaces: next.workspaces,
        sidebar: next.sidebar,
      });
      persist();
      get().startRename({
        kind: "workspace",
        id: workspace.id,
        where: "sidebar",
      });
      return workspace.id;
    },

    dissolveWorkspace(workspaceId) {
      patchLayout((layout) =>
        dissolveWorkspaceLayout(layout.workspaces, layout.sidebar, workspaceId),
      );
    },

    selectWorkspace(workspaceId) {
      const { workspaces } = layoutOf();
      const workspace = workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return;
      if (workspace.collapsed) {
        set({
          workspaces: setWorkspaceCollapsed(workspaces, workspaceId, false),
        });
      }
      const member =
        (workspace.activeProjectId &&
        workspace.projectIds.includes(workspace.activeProjectId)
          ? workspace.activeProjectId
          : workspace.projectIds[0]) ?? null;
      if (member) get().selectProject(member);
      else persist();
    },

    toggleWorkspaceCollapsed(workspaceId) {
      const { workspaces } = layoutOf();
      const workspace = workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return;
      set({
        workspaces: setWorkspaceCollapsed(
          workspaces,
          workspaceId,
          !workspace.collapsed,
        ),
      });
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
        get().settleRestore(paneId, true);
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
          accountId: accountFor(spec, get().accounts),
          resumeAgent: spec.agentId !== null,
          ...unboundSession(),
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
            accountId: accountFor(spec, get().accounts),
            resumeAgent: spec.agentId !== null,
            ...unboundSession(),
            title: spec.title ?? defaultTitle(agents, spec.agentId),
            cwd: spec.cwd ?? null,
          };
        }
        const batch = gridOf(ids);
        // Several at once means a batch launch â€” lay them out as a grid.
        return {
          ...current,
          // Beside what is already there, never re-gridded into it: the panes
          // the user arranged stay where they put them.
          tree: current.tree && batch ? besideTree(current.tree, batch) : batch,
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

      // Splitting an editor opens what it is showing a second time beside it.
      if (source.editor) {
        const editor = source.editor;
        const shown =
          editor.tabs.find((tab) => editorRefId(tab) === editor.active) ??
          editor.tabs[0];
        if (!shown) return;
        const copy = makeId("pane");
        updateDeck(projectId, deck.id, (current) => ({
          ...current,
          tree: current.tree
            ? splitPane(current.tree, paneId, direction, copy)
            : paneLeaf(copy),
          panes: {
            ...current.panes,
            [copy]: showTab(blankEditorPane(copy), [shown], editorRefId(shown)),
          },
          focused: copy,
          zoomed: null,
        }));
        return;
      }

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
      // Closing a waiting pane cancels its restore obligation.
      get().settleRestore(paneId, true);
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

    dismissPane(projectId, paneId) {
      if (paneId in get().closing) return;
      const project = get().projects.find((item) => item.id === projectId);
      const deck = project ? deckOfPane(project, paneId) : null;
      const onScreen =
        project !== undefined &&
        deck !== null &&
        get().activeProjectId === projectId &&
        project.activeDeckId === deck.id &&
        (deck.zoomed === null || deck.zoomed === paneId);
      if (!onScreen) {
        get().closePane(projectId, paneId);
        return;
      }
      set((state) => ({ closing: { ...state.closing, [paneId]: true } }));
      setTimeout(() => {
        set((state) => {
          const closing = { ...state.closing };
          delete closing[paneId];
          return { closing };
        });
        get().closePane(projectId, paneId);
      }, PANE_EXIT_MS);
    },

    openInEditor(projectId, ref) {
      const project = get().projects.find((item) => item.id === projectId);
      const deck = activeDeck(project);
      if (!project || !deck) return;
      const id = editorRefId(ref);
      const editors = listPanes(deck.tree).filter(
        (paneId) => deck.panes[paneId]?.editor,
      );
      const holding = editors.find((paneId) =>
        deck.panes[paneId].editor?.tabs.some((tab) => editorRefId(tab) === id),
      );
      const focusedEditor =
        deck.focused && editors.includes(deck.focused) ? deck.focused : null;
      const target = holding ?? focusedEditor ?? editors[0] ?? null;

      if (target) {
        updateDeck(projectId, deck.id, (current) => {
          const pane = current.panes[target];
          const tabs = pane.editor?.tabs ?? [];
          const next = tabs.some((tab) => editorRefId(tab) === id)
            ? tabs
            : [...tabs, ref];
          return {
            ...current,
            panes: { ...current.panes, [target]: showTab(pane, next, id) },
            focused: target,
            // Another pane filling the deck would hide the file you asked for.
            zoomed: current.zoomed === target ? target : null,
          };
        });
        return;
      }

      const paneId = makeId("pane");
      updateDeck(projectId, deck.id, (current) => ({
        ...current,
        tree: dockAtEdge(current.tree, paneId),
        panes: {
          ...current.panes,
          [paneId]: showTab(blankEditorPane(paneId), [ref], id),
        },
        focused: paneId,
        zoomed: null,
      }));
    },

    selectEditorTab(projectId, paneId, tabId) {
      updateDeckOfPane(projectId, paneId, (deck) => {
        const pane = deck.panes[paneId];
        if (!pane?.editor) return deck;
        return {
          ...deck,
          panes: {
            ...deck.panes,
            [paneId]: showTab(pane, pane.editor.tabs, tabId),
          },
          focused: paneId,
        };
      });
    },

    closeEditorTab(projectId, paneId, tabId) {
      const project = get().projects.find((item) => item.id === projectId);
      const pane = project ? deckOfPane(project, paneId)?.panes[paneId] : null;
      const editor = pane?.editor;
      if (!editor) return;
      const index = editor.tabs.findIndex((tab) => editorRefId(tab) === tabId);
      if (index < 0) return;
      const rest = editor.tabs.filter((_, at) => at !== index);
      if (rest.length === 0) {
        get().dismissPane(projectId, paneId);
        return;
      }
      // Closing the tab you are on shows its neighbour, the way browsers do.
      const active =
        editor.active === tabId
          ? editorRefId(rest[Math.min(index, rest.length - 1)])
          : editor.active;
      updateDeckOfPane(projectId, paneId, (deck) => ({
        ...deck,
        panes: {
          ...deck.panes,
          [paneId]: showTab(deck.panes[paneId], rest, active),
        },
      }));
    },

    rewriteEditorTabs(projectPath, change) {
      const emptied: { projectId: string; paneId: string }[] = [];
      let touched = false;
      const projects = get().projects.map((project) => {
        if (project.path !== projectPath) return project;
        let projectTouched = false;
        const decks = project.decks.map((deck) => {
          let panes: Record<string, Pane> | null = null;
          for (const [paneId, pane] of Object.entries(deck.panes)) {
            if (!pane.editor) continue;
            const renamed = new Map<string, string>();
            let changed = false;
            const tabs = pane.editor.tabs.flatMap((tab) => {
              const next = change(tab);
              if (next === tab) return [tab];
              changed = true;
              if (!next) return [];
              renamed.set(editorRefId(tab), editorRefId(next));
              return [next];
            });
            if (!changed) continue;
            // Two tabs that now name the same file are one tab.
            const unique = tabs.filter(
              (tab, at) =>
                tabs.findIndex((other) => editorRefId(other) === editorRefId(tab)) === at,
            );
            const active = pane.editor.active
              ? (renamed.get(pane.editor.active) ?? pane.editor.active)
              : null;
            panes ??= { ...deck.panes };
            panes[paneId] = showTab(pane, unique, active);
            if (unique.length === 0) emptied.push({ projectId: project.id, paneId });
          }
          if (!panes) return deck;
          projectTouched = true;
          return { ...deck, panes };
        });
        if (!projectTouched) return project;
        touched = true;
        return { ...project, decks };
      });
      if (!touched) return;
      set({ projects });
      persist();
      for (const { projectId, paneId } of emptied) {
        get().dismissPane(projectId, paneId);
      }
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

    dropPane(projectId, paneId, targetId, zone) {
      updateDeckOfPane(projectId, paneId, (deck) => {
        if (!deck.tree) return deck;
        const tree =
          zone === "center"
            ? swapPanes(deck.tree, paneId, targetId)
            : dockPane(deck.tree, paneId, targetId, zone);
        return { ...deck, tree, focused: paneId, zoomed: null };
      });
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
    const nextDoneAt: Record<string, number> = {};
    let changed = false;

    const now = Date.now();
    // The terminal in front of you, while the window has focus. An agent that
    // finishes there was never waiting for you.
    const watching = document.hasFocus()
      ? lookingAt(state.projects, state.activeProjectId)
      : null;

    for (const project of state.projects) {
      for (const deck of project.decks) {
        for (const [paneId, pane] of Object.entries(deck.panes)) {
          const previous = state.status[paneId] ?? "idle";
          const entry = activity.get(paneId);
          let current: PaneStatus = "idle";

          if (
            pane.agentId !== null &&
            pane.resumeAgent &&
            entry &&
            !(paneId in state.exited)
          ) {
            if (entry.runStart !== null && now - entry.lastOutput >= QUIET_MS) {
              entry.runStart = null;
            }
            const sustained =
              entry.runStart !== null &&
              entry.lastOutput - entry.runStart >= MIN_RUN_MS;
            if (sustained || (previous === "working" && entry.runStart !== null)) {
              current = "working";
            } else if (previous === "working") {
              current = paneId === watching ? "idle" : "done";
            } else {
              current = previous;
            }
          }

          next[paneId] = current;
          if (current === "done") {
            nextDoneAt[paneId] =
              previous === "done" ? (state.doneAt[paneId] ?? now) : now;
          }
          if (current !== previous) changed = true;
        }
      }
    }

    if (
      changed ||
      Object.keys(next).length !== Object.keys(state.status).length
    ) {
      useKeel.setState({ status: next, doneAt: nextDoneAt });
    }
  }, 350);

  return () => clearInterval(timer);
}

