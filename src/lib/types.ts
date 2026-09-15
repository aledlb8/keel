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
 * What a pane's agent is doing, inferred from output timing alone. Plain shells
 * are always `idle`; `done` means an agent finished working and you have not
 * been back to it since.
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
  titleLocked?: boolean;
  /** Absolute path the shell starts in. `null` falls back to the project root. */
  cwd: string | null;
  /**
   * Present on an editor pane: the files and diffs open in it. A pane with this
   * set runs no process — the agent and session fields above stay empty.
   */
  editor?: PaneEditor;
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
  start?: string;
  resume: string;
  /** `subcommand` inserts after the binary (`codex resume {id}`). */
  kind?: "args" | "subcommand";
  store?: "grok" | "claude";
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
  session?: SessionSpec | null;
  /** Up to three characters, shown wherever the agent is drawn small. */
  short: string;
  /** Hex colour, or empty for the neutral fallback. */
  accent: string;
  /** Environment variable that points this CLI at an alternate config home. */
  accountEnv?: string | null;
  /** Executable names looked for on PATH. Empty uses the command's first word. */
  bins: string[];
  /** Extra folders searched; `{home}` expands to the home directory. */
  paths: string[];
  /** Kept out of the launcher. */
  hidden?: boolean;
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
  isDefault?: boolean;
}

/** Private OpenVPN tunnel settings. The rest of the PC stays off the VPN. */
export interface VpnSettings {
  /** Bring the tunnel up when Keel starts. */
  autoConnect: boolean;
  /** OpenVPN Connect profile id (file stem). `null` uses the only/first one. */
  profileId: string | null;
}

export interface VpnProfileInfo {
  id: string;
  name: string;
  path: string;
}

export type VpnPhase = "idle" | "connecting" | "connected" | "error";

/** Live tunnel state. Only `autoConnect` / `profileId` are written to disk. */
export interface VpnState extends VpnSettings {
  phase: VpnPhase;
  /** False while auto-connect is still bringing the tunnel up. */
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
  version: 4;
  projects: Project[];
  activeProjectId: string | null;
  accounts: AgentAccount[];
  vpn?: VpnSettings;
  /** Only the shortcuts you changed; everything else follows the defaults. */
  keybindings?: KeybindingOverrides;
}
