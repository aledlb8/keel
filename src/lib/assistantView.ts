/**
 * How the main agent sees Keel. Pure functions over store state, so what the
 * agent is told can be tested without a window.
 *
 * Everything here becomes text in a model's context and, through /status, a
 * message on a phone. It names things the way the sidebar does, and gives ids
 * only where the agent needs one to act.
 */

import { listPanes } from "./tree.ts";
import type { Agent, AgentAccount, PaneStatus, Project, Workspace } from "./types.ts";
import { formatPercent, formatReset, profileLabel, windowName, type AgentUsage } from "./usage.ts";

export interface WorkspaceView {
  agents: Agent[];
  projects: Project[];
  workspaces: Workspace[];
  activeProjectId: string | null;
  status: Record<string, PaneStatus>;
  exited: Record<string, true>;
  /** Panes the main agent started. */
  delegated: ReadonlySet<string>;
  /** Panes the user opened that the main agent passed a request to. */
  handed: ReadonlySet<string>;
}

const STATUS_WORDS: Record<PaneStatus, string> = {
  idle: "idle",
  working: "working",
  waiting: "waiting for input",
  done: "done",
};

function agentName(agents: Agent[], id: string | null): string {
  if (id === null) return "shell";
  return agents.find((agent) => agent.id === id)?.name ?? id;
}

/** Everything open, as a short indented outline. */
export function describeWorkspace(view: WorkspaceView): string {
  const lines: string[] = [];
  const startable = view.agents.filter((agent) => agent.installed && !agent.hidden);
  lines.push(
    startable.length
      ? `Agents you can start: ${startable.map((agent) => `${agent.id} (${agent.name})`).join(", ")}`
      : "No agent CLIs are installed.",
  );

  if (view.projects.length === 0) {
    lines.push("", "No projects are open in Keel.");
    return lines.join("\n");
  }

  const grouped = new Map<string, string>();
  for (const workspace of view.workspaces) {
    for (const id of workspace.projectIds) grouped.set(id, workspace.name);
  }

  for (const project of view.projects) {
    lines.push("");
    const notes = [
      project.id === view.activeProjectId ? "on screen" : null,
      grouped.has(project.id) ? `workspace ${grouped.get(project.id)}` : null,
    ].filter(Boolean);
    lines.push(
      `Project "${project.name}" — ${project.path}${notes.length ? ` (${notes.join(", ")})` : ""}`,
    );
    const many = project.decks.length > 1;
    let empty = true;
    for (const deck of project.decks) {
      const ids = listPanes(deck.tree);
      if (ids.length === 0) continue;
      empty = false;
      if (many) lines.push(`  Deck "${deck.name}"`);
      for (const id of ids) {
        const pane = deck.panes[id];
        if (!pane) continue;
        const indent = many ? "    " : "  ";
        if (pane.editor) {
          lines.push(`${indent}- ${id}: editor (${pane.editor.tabs.length} file tab(s))`);
          continue;
        }
        const state =
          id in view.exited
            ? "exited"
            : pane.agentId === null || !pane.resumeAgent
              ? "shell prompt"
              : STATUS_WORDS[view.status[id] ?? "idle"];
        const running =
          pane.agentId !== null && pane.resumeAgent ? agentName(view.agents, pane.agentId) : "shell";
        const extras = [
          pane.cwd && pane.cwd !== project.path ? `in ${pane.cwd}` : null,
          view.delegated.has(id)
            ? "started by you"
            : view.handed.has(id)
              ? "you passed it a request"
              : null,
        ].filter(Boolean);
        lines.push(
          `${indent}- ${id}: ${running}, ${state}, "${pane.title}"${extras.length ? ` (${extras.join(", ")})` : ""}`,
        );
      }
    }
    if (empty) lines.push("  (no panes)");
  }
  return lines.join("\n");
}

function normal(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** A project by id, name or folder, ignoring case. */
export function findProject(projects: Project[], query: string): Project | null {
  const wanted = query.trim();
  if (!wanted) return null;
  const lower = wanted.toLowerCase();
  return (
    projects.find((project) => project.id === wanted) ??
    projects.find((project) => project.name.toLowerCase() === lower) ??
    projects.find((project) => normal(project.path) === normal(wanted)) ??
    projects.find((project) => normal(project.path).endsWith(`/${lower}`)) ??
    null
  );
}

export type PaneEventKind = "done" | "waiting" | "exited";

export interface PaneChange {
  paneId: string;
  kind: PaneEventKind;
}

/**
 * Edges worth telling the main agent or the phone about, between two readings
 * of pane status. A pane the agent is waiting on (one it started, or passed a
 * request to) also counts as finished when it stops working while you watch
 * it — the tracker never calls that `done`.
 */
export function paneChanges(
  before: { status: Record<string, PaneStatus>; exited: Record<string, true> },
  after: { status: Record<string, PaneStatus>; exited: Record<string, true> },
  followed: ReadonlySet<string>,
): PaneChange[] {
  const changes: PaneChange[] = [];
  for (const [paneId, current] of Object.entries(after.status)) {
    const previous = before.status[paneId] ?? "idle";
    if (previous === current) continue;
    if (current === "done") changes.push({ paneId, kind: "done" });
    else if (current === "waiting") changes.push({ paneId, kind: "waiting" });
    else if (current === "idle" && previous === "working" && followed.has(paneId)) {
      changes.push({ paneId, kind: "done" });
    }
  }
  for (const paneId of Object.keys(after.exited)) {
    if (!(paneId in before.exited)) changes.push({ paneId, kind: "exited" });
  }
  return changes;
}

const DIGITS = Array.from({ length: 9 }, (_, index) => `${index + 1}`);

/**
 * The keys the agent may press in a pane, as the bytes a terminal sends.
 * Digits are keys, not text: agents' menus pick an option on its number, but
 * ignore the same digit pasted by `send_to_pane`.
 */
export const PANE_KEYS: Record<string, string> = {
  escape: "\x1b",
  ctrl_c: "\x03",
  enter: "\r",
  tab: "\t",
  shift_tab: "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  backspace: "\x7f",
  ...Object.fromEntries(DIGITS.map((digit) => [digit, digit])),
};

/** Keys that give a pane the user's choice, so its outcome is owed to them. */
export const ANSWER_KEYS: ReadonlySet<string> = new Set(["enter", ...DIGITS]);

/** Keys that stop what a pane was doing, so nothing is owed any more. */
export const INTERRUPT_KEYS: ReadonlySet<string> = new Set(["escape", "ctrl_c"]);

/**
 * Plan limits as the agent reads them: one line per login, each window with
 * how much is used and when it resets.
 */
export function describeUsage(
  usage: AgentUsage[],
  accounts: AgentAccount[],
  now = Date.now(),
): string {
  if (usage.length === 0) return "Keel couldn't read usage for any signed-in agent.";
  return usage
    .map((item) => {
      const profile = item.accountId ? ` (${profileLabel(item.accountId, accounts)})` : "";
      const plan = item.plan ? `, ${item.plan}` : "";
      const head = `${item.name}${profile}${plan}`;
      if (item.status !== "ok") return `${head}: couldn't read it (${item.error ?? "unknown error"}).`;
      if (item.windows.length === 0) return `${head}: no limits reported.`;
      const windows = item.windows.map((window) => {
        const reset = formatReset(window.resetsAt, now);
        return `${windowName(window.label)} ${formatPercent(window.usedPercent)} used${
          reset ? `, resets in ${reset}` : ""
        }`;
      });
      return `${head}: ${windows.join("; ")}.`;
    })
    .join("\n");
}
