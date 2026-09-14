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

/** What a pane's agent is doing, inferred from output timing alone. */
export type PaneStatus = "idle" | "working" | "waiting" | "exited";

export interface Pane {
  id: string;
  /** `null` means a plain shell with nothing typed into it. */
  agentId: string | null;
  /** Named isolated login for this agent. `null` uses the CLI's normal login. */
  accountId: string | null;
  title: string;
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

export interface Agent {
  id: string;
  name: string;
  command: string;
  short: string;
  accent: string;
  /** Environment variable that points this CLI at an alternate config home. */
  accountEnv?: string | null;
  path: string | null;
  installed: boolean;
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
