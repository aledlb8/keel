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

export type UsageLevel = "ok" | "warn" | "hot";

/** Colour band for a used percentage: calm, getting close, nearly out. */
export function usageLevel(used: number): UsageLevel {
  if (used >= 90) return "hot";
  if (used >= 75) return "warn";
  return "ok";
}

const WINDOW_NAMES: Record<string, string> = {
  "5h": "5-hour",
  "1d": "Daily",
  wk: "Weekly",
  mo: "Monthly",
};

/** Spell out the backend's terse window tags; model buckets pass through. */
export function windowName(label: string): string {
  return WINDOW_NAMES[label] ?? label;
}

const WINDOW_SHORT: Record<string, string> = {
  "5h": "5h",
  "1d": "Day",
  wk: "Wk",
  mo: "Mo",
};

/** A window's name in a glance: "5h", "Wk", or the first letters of a model bucket. */
export function windowShortName(label: string): string {
  return WINDOW_SHORT[label] ?? label.slice(0, 4);
}

export const USAGE_POLL_MS = 120_000;

/**
 * How long a good reading outlives failed polls. Long enough that one flaky
 * request never makes a login blink out of the footer; short enough that a
 * login that has really gone away (signed out, token expired) stops claiming
 * numbers it no longer has.
 */
export const USAGE_STALE_MS = 10 * 60_000;

/** The same key the footer and the focused pane use for a login. */
export function usageKey(agentId: string, accountId: string | null | undefined): string {
  return `${agentId}:${accountId ?? ""}`;
}

/** A reading worth showing: it answered, and it has at least one real window. */
export function isReady(usage: AgentUsage): boolean {
  return (
    usage.status === "ok" &&
    usage.windows.some((window) => Number.isFinite(window.usedPercent))
  );
}

export interface KeptUsage {
  usage: AgentUsage;
  /** When this reading arrived, on our clock. */
  at: number;
}

/**
 * Fold a poll into what is already on screen. Good readings replace the old
 * ones; an error or an empty answer never does — the last good reading stays
 * until it is older than `maxAgeMs`. Logins no longer being asked about go.
 */
export function retainUsage(
  kept: Map<string, KeptUsage>,
  fresh: AgentUsage[],
  now: number,
  live: Set<string>,
  maxAgeMs = USAGE_STALE_MS,
): Map<string, KeptUsage> {
  const next = new Map<string, KeptUsage>();
  for (const [key, entry] of kept) {
    if (live.has(key) && now - entry.at <= maxAgeMs) next.set(key, entry);
  }
  for (const usage of fresh) {
    const key = usageKey(usage.agentId, usage.accountId);
    if (live.has(key) && isReady(usage)) next.set(key, { usage, at: now });
  }
  return next;
}

/** How much of a window has already passed, 0…1, or null when it can't be known. */
export function windowElapsed(window: UsageWindow, now: number): number | null {
  if (!window.resetsAt || !(window.windowMinutes > 0)) return null;
  const span = window.windowMinutes * 60_000;
  const left = window.resetsAt - now;
  if (left <= 0) return 1;
  if (left >= span) return 0;
  return 1 - left / span;
}

/**
 * Burning through the window noticeably faster than time is passing — at this
 * rate it runs out before it resets. Ignored early on, when a few requests can
 * look like a lot.
 */
export function aheadOfPace(window: UsageWindow, now: number): boolean {
  const elapsed = windowElapsed(window, now);
  if (elapsed === null) return false;
  const used = Math.min(100, Math.max(0, window.usedPercent)) / 100;
  return used >= 0.25 && used - elapsed >= 0.15;
}

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
