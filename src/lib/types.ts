/** Shapes shared across the app. The persisted document is built from these. */

export type Direction = "row" | "column";

/** A leaf is a pane; its `id` *is* the pane id. */
export type LayoutNode =
  | { kind: "pane"; id: string }
  | {
      kind: "split";
      id: string;
      direction: Direction;
      children: LayoutNode[];
      /** Fractions, one per child, summing to 1. */
      sizes: number[];
    };

/**
 * What a pane's agent is doing, inferred from live turn and prompt evidence.
 * Plain shells are always `idle`; `done` means a supported agent returned to
 * its prompt after working and you have not been back to it since.
 */
export type PaneStatus = "idle" | "working" | "done";

/** Things a terminal reports that explain the output that follows them. */
export type PaneActivity = "input" | "resize" | "spawn";

export interface Pane {
  id: string;
  /** `null` means a plain shell with nothing typed into it. */
  agentId: string | null;
  /** Named isolated login for this agent. `null` uses the CLI's normal login. */
  accountId: string | null;
  /**
   * Type the agent command when this pane's shell starts. Cleared once that
   * process exits, so a reopen continues from the shell you were already in
   * rather than launching the agent again. Restart arms it.
   */
  resumeAgent: boolean;
  /**
   * Conversation this pane owns, once captured from the agent. `null` until
   * then. Leftover generated UUIDs from older builds are ignored until
   * `sessionReady` is true.
   */
  sessionId: string | null;
  /**
   * True when `sessionId` is a captured conversation this pane may resume.
   * False means launch the bare command; capture will bind the real id later.
   */
  sessionReady: boolean;
  title: string;
  /**
   * Set once you name the pane yourself. Auto-titles from a prompt or OSC
   * leave these alone.
   */
  titleLocked?: boolean | undefined;
  /**
   * Absolute path the shell runs in. Spawned there and then kept in step with
   * the shell's own `cd` — the prompt reports each folder change — so a
   * restart reopens where you actually got to. `null` falls back to the
   * project root.
   */
  cwd: string | null;
  /**
   * Present on an editor pane: the files and diffs open in it. A pane with this
   * set runs no process — the agent and session fields above stay empty.
   */
  editor?: PaneEditor | undefined;
  /**
   * When true, this pane does not raise an OS toast. Sounds still play when
   * another terminal or surface has focus. Omitted when
   * false so the saved layout stays clean.
   */
  muted?: boolean | undefined;
}

/** A file, or one side of a git change, open in an editor pane. */
export interface EditorRef {
  kind: "file" | "diff";
  /** Relative to the project folder, with forward slashes. */
  rel: string;
  /** For a diff: the staged side rather than the working tree. */
  staged: boolean;
}

/** What an editor pane shows. Only this is saved; the text is read from disk. */
export interface PaneEditor {
  tabs: EditorRef[];
  /** The id (see `editorRefId`) of the tab on screen. */
  active: string | null;
}

/**
 * One arrangement of terminals inside a project.
 *
 * A project starts with a single deck and shows no sign it has any — the deck
 * rail, the extra sidebar level and the overview all stay out of the way until
 * there is a second one to switch between.
 */
export interface Deck {
  id: string;
  name: string;
  tree: LayoutNode | null;
  panes: Record<string, Pane>;
  /** Pane blown up to fill the canvas, or `null`. */
  zoomed: string | null;
  focused: string | null;
}

/**
 * A project is a folder plus the decks of terminals open inside it.
 *
 * Selecting a project is one-way: there is no "no project" state, because a
 * terminal with no folder to start in is not useful. Decks in projects you are
 * not looking at keep running.
 *
 * A project may sit on its own in the sidebar, or belong to one workspace. It
 * never belongs to two: membership is exclusive, and dissolving a workspace
 * puts its members back on their own.
 */
export interface Project {
  id: string;
  name: string;
  path: string;
  decks: Deck[];
  activeDeckId: string | null;
  /** Whether its contents are folded away in the sidebar. */
  collapsed: boolean;
}

/**
 * A named group of existing projects.
 *
 * A workspace is not a folder and does not own terminals, decks, or a file
 * tree — those stay on the member projects. It is only a way of arranging
 * related work in the sidebar, the way a deck arranges terminals inside a
 * project. Dissolving one never deletes a project.
 *
 * The file inspector (`useWorkspace`, `src/lib/workspace.ts`) is a different
 * thing: the files of the folder you are looking at. That name was here first.
 */
export interface Workspace {
  id: string;
  name: string;
  /** Whether its member projects are folded away in the sidebar. */
  collapsed: boolean;
  /** Member project ids, in the order they appear under this workspace. */
  projectIds: string[];
  /** Last member you were in while this workspace was current. */
  activeProjectId: string | null;
}

/**
 * One row at the top of the sidebar: a workspace, or a project that is not
 * inside any workspace. Nested projects live on `Workspace.projectIds`.
 */
export type SidebarRoot =
  | { kind: "workspace"; id: string }
  | { kind: "project"; id: string };

/**
 * Extra args (or a subcommand) that reopen a CLI's conversation.
 *
 * `resume` is typed only when this pane has a captured conversation
 * (`sessionReady`). `{id}` is that conversation — never `--continue`, which
 * would give every pane of the same agent the most recent chat in the folder.
 * `start` is legacy: some CLIs accept `--session-id` on first launch, but
 * ordinary new panes do not use it. The agent creates the conversation; Keel
 * captures the id afterwards.
 * `store` names the on-disk layout used to discover that id.
 */
export interface SessionSpec {
  start?: string | undefined;
  resume: string;
  /** `subcommand` inserts after the binary (`codex resume {id}`). */
  kind?: "args" | "subcommand" | undefined;
  store?: "grok" | "claude" | "opencode" | undefined;
}

/** One entry of the agent catalogue, exactly as it is saved. */
export interface AgentSpec {
  /** Stable key. Saved layouts reference agents by this. */
  id: string;
  name: string;
  /** Typed into a fresh shell. */
  command: string;
  /**
   * How this CLI reopens a captured conversation. Absent means every spawn
   * is a new session. `{id}` is replaced with the pane's captured `sessionId`.
   */
  session?: SessionSpec | null | undefined;
  /** Up to three characters, shown wherever the agent is drawn small. */
  short: string;
  /** Hex colour, or empty for the neutral fallback. */
  accent: string;
  /** Environment variable that points this CLI at an alternate config home. */
  accountEnv?: string | null | undefined;
  /** Executable names looked for on PATH. Empty uses the command's first word. */
  bins: string[];
  /** Extra folders searched; `{home}` expands to the home directory. */
  paths: string[];
  /** Kept out of the launcher. */
  hidden?: boolean | undefined;
}

/** A catalogue entry plus what detection found. */
export interface Agent extends AgentSpec {
  path: string | null;
  installed: boolean;
  /** Ships with Keel: can be reset to defaults, but not deleted. */
  builtin: boolean;
}

import type { KeybindingOverrides } from "./keymap";

/** A named login slot. Credentials stay in the agent's own isolated config dir. */
export interface AgentAccount {
  id: string;
  agentId: string;
  name: string;
  /** New terminals of this agent start on it. At most one per agent. */
  isDefault?: boolean | undefined;
}

/** Private OpenVPN tunnel settings. The rest of the PC stays off the VPN. */
export interface VpnSettings {
  /** Bring the tunnel up when Keel starts. */
  autoConnect: boolean;
  /**
   * Disk-only opt-in. Older documents saved `autoConnect: true` as the default;
   * launch only connects when this flag is present and true.
   */
  connectOnLaunch?: boolean | undefined;
  /** OpenVPN Connect profile id (file stem). `null` uses the only/first one. */
  profileId: string | null;
}

export interface VpnProfileInfo {
  id: string;
  name: string;
  path: string;
}

export type VpnPhase = "idle" | "connecting" | "connected" | "error";

/** Live tunnel state. Only `autoConnect` / `connectOnLaunch` / `profileId` are written to disk. */
export interface VpnState extends VpnSettings {
  phase: VpnPhase;
  /**
   * New/restarted terminals may spawn. False while a connect is in flight, and
   * while connect-on-launch still needs a tunnel (idle/error at startup).
   * Disconnecting releases the hold so an explicit opt-out is not stuck.
   */
  spawnAllowed: boolean;
  connectInstalled: boolean;
  openvpnPath: string | null;
  profiles: VpnProfileInfo[];
  profileName: string | null;
  adapter: string | null;
  tunnelIp: string | null;
  proxyPort: number | null;
  isolated: boolean;
  error: string | null;
  dialogOpen: boolean;
}

/** Everything written to disk. Live PTYs are deliberately not part of it. */
export interface PersistedState {
  version: 5;
  projects: Project[];
  workspaces: Workspace[];
  /** Top-level sidebar order. Missing or stale ids are repaired on load. */
  sidebar: SidebarRoot[];
  activeProjectId: string | null;
  accounts: AgentAccount[];
  vpn?: VpnSettings | undefined;
  /** Only the shortcuts you changed; everything else follows the defaults. */
  keybindings?: KeybindingOverrides | undefined;
}
