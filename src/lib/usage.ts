/**
 * Live subscription meters for the agent CLIs Keel knows how to ask.
 *
 * The backend reads each CLI's own auth file and calls the same quota endpoint
 * that CLI uses. Agents without credentials, or without a quota API, are omitted.
 * Named profiles are extra queries against that agent's isolated config dir.
 */

import type { Agent, AgentAccount } from "./types";

export interface UsageWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number | null;
  label: string;
}

export interface AgentUsage {
  agentId: string;
  accountId: string | null;
  short: string;
  name: string;
  accent: string;
  plan: string | null;
  windows: UsageWindow[];
  status: "ok" | "error";
  error: string | null;
  updatedAt: number;
}

export interface UsageSnapshot {
  agents: AgentUsage[];
  fetchedAt: number;
}

export interface UsageAgentQuery {
  id: string;
  short: string;
  name: string;
  accent: string;
  accountId?: string | null;
}

export function formatReset(resetsAt: number | null, now = Date.now()): string {
  if (!resetsAt) return "";
  const ms = resetsAt - now;
  if (ms <= 0) return "now";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours ? `${days}d ${remainHours}h` : `${days}d`;
}

export function formatPercent(used: number): string {
  if (!Number.isFinite(used)) return "0%";
  const rounded = Math.round(Math.min(100, Math.max(0, used)));
  return `${rounded}%`;
}

/** The window closest to empty — that is the one that will stop you first. */
export function tightestWindow(windows: UsageWindow[]): UsageWindow | null {
  if (windows.length === 0) return null;
  return windows.reduce((best, window) =>
    window.usedPercent >= best.usedPercent ? window : best,
  );
}

export const USAGE_POLL_MS = 120_000;

export const USAGE_AGENT_IDS = [
  "claude",
  "codex",
  "gemini",
  "grok",
  "opencode",
] as const;

const DEFAULT_PROFILE = "Default";

export function profileLabel(
  accountId: string | null | undefined,
  accounts: AgentAccount[],
): string {
  if (!accountId) return DEFAULT_PROFILE;
  return accounts.find((account) => account.id === accountId)?.name ?? "Profile";
}

/**
 * One request per login slot: the agent's default home, then every named
 * profile that can isolate its config. Profiles for agents without a quota
 * API, or without an isolation variable, are skipped.
 */
export function buildUsageQueries(
  agents: Agent[],
  accounts: AgentAccount[],
): UsageAgentQuery[] {
  const queries: UsageAgentQuery[] = [];
  for (const agent of agents) {
    if (agent.hidden) continue;
    if (
      !USAGE_AGENT_IDS.includes(agent.id as (typeof USAGE_AGENT_IDS)[number])
    ) {
      continue;
    }
    const short = agent.short || agent.id.slice(0, 2).toUpperCase();
    const base = {
      id: agent.id,
      short,
      name: agent.name,
      accent: agent.accent,
    };
    queries.push({ ...base, accountId: null });
    if (!agent.accountEnv?.trim()) continue;
    for (const account of accounts) {
      if (account.agentId !== agent.id) continue;
      queries.push({ ...base, accountId: account.id });
    }
  }
  return queries;
}

export function usageQueryKey(query: UsageAgentQuery[]): string {
  return query
    .map((item) => `${item.id}:${item.accountId ?? ""}`)
    .sort()
    .join("|");
}
