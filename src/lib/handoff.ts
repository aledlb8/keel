/**
 * Handing a pane's conversation to another agent: which panes can, and who
 * they can hand to. Pure functions over store state; the work itself is in
 * `src/state/handoff.ts` and `src-tauri/src/handoff.rs`.
 */

import { isSessionId } from "./launch.ts";
import type { Agent, AgentAccount, Pane } from "./types.ts";

/**
 * Agents whose conversations Keel can read back. Mirrors `handoff::SOURCES`:
 * each reports its session id through hooks, which is what ties a pane to
 * exactly one conversation.
 */
export const HANDOFF_SOURCES: readonly string[] = ["claude", "codex", "grok", "opencode"];

/** The pane owns a conversation Keel can read. */
export function canHandOff(pane: Pane): boolean {
  return (
    pane.editor === undefined &&
    pane.agentId !== null &&
    HANDOFF_SOURCES.includes(pane.agentId) &&
    pane.sessionReady &&
    pane.sessionId !== null &&
    isSessionId(pane.sessionId)
  );
}

/** One agent, and the profiles it could start on. */
export interface HandoffTarget {
  agent: Agent;
  /**
   * Profiles to choose between. Empty: the agent starts on the profile new
   * terminals use, with nothing to choose.
   */
  profiles: { accountId: string | null; label: string }[];
}

/** Installed agents, in catalogue order, each with its profiles. */
export function handoffTargets(agents: Agent[], accounts: AgentAccount[]): HandoffTarget[] {
  return agents
    .filter((agent) => agent.installed && !agent.hidden)
    .map((agent) => {
      const own = agent.accountEnv
        ? accounts.filter((account) => account.agentId === agent.id)
        : [];
      return {
        agent,
        profiles: own.length
          ? [
              { accountId: null, label: "Default" },
              ...own.map((account) => ({ accountId: account.id, label: account.name })),
            ]
          : [],
      };
    });
}

/** "Codex", or "Claude Code (new chat)" when an agent hands to itself. */
export function targetLabel(target: Agent, sourceId: string | null): string {
  return target.id === sourceId ? `${target.name} (new chat)` : target.name;
}

/** The new pane's name: what it carries on with, and from whom. */
export function handoffTitle(title: string, source: string): string {
  const suffix = ` · from ${source}`;
  const room = 60 - suffix.length;
  const base = title.trim() || "Handoff";
  return `${base.length > room ? `${base.slice(0, room - 1).trimEnd()}…` : base}${suffix}`;
}
