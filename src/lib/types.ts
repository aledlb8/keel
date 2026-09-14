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
   * UUID handed to CLIs that let us pick a session id. `null` when this agent
   * has no such flag, or when the pane predates session tracking.
   */
  sessionId: string | null;
  /**
   * The agent has come up at least once, so the next spawn should resume the
   * conversation instead of opening a new one.
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
 * `start` is typed on the first spawn; `resume` on every spawn after that.
 * `{id}` is this pane's session id — never `--continue`, which would give
 * every pane of the same agent the most recent chat in the folder.
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
   * How this CLI reopens a conversation. Absent means every spawn is a new
   * session. `{id}` is replaced with the pane's `sessionId`.
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

/** A named login slot. Credentials stay in the agent's own isolated config dir. */
export interface AgentAccount {
  id: string;
  agentId: string;
  name: string;
}

/** Everything written to disk. Live PTYs are deliberately not part of it. */
export interface PersistedState {
  version: 4;
  projects: Project[];
  activeProjectId: string | null;
  accounts: AgentAccount[];
}
