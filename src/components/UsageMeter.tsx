/**
 * Compact subscription chips for the footer.
 *
 * One chip per signed-in login: the agent's default home, then every named
 * profile that has credentials. Hover expands every window plus the reset
 * countdown. Agents without a quota API, or without credentials on disk, stay
 * off the bar entirely.
 */

import { useEffect, useState } from "react";

import { agentAccent } from "@/lib/tokens";
import { useAgentUsage } from "@/lib/useAgentUsage";
import {
  formatPercent,
  formatReset,
  profileLabel,
  tightestWindow,
  type AgentUsage,
  type UsageWindow,
} from "@/lib/usage";
import type { AgentAccount } from "@/lib/types";
import { cn } from "@/lib/utils";

export function UsageMeter() {
  const { agents, fetching, accounts, activeKey } = useAgentUsage();
  if (agents.length === 0) return null;

  const counts = new Map<string, number>();
  for (const row of agents) {
    counts.set(row.agentId, (counts.get(row.agentId) ?? 0) + 1);
  }

  return (
    <div
      className={cn(
        "ml-auto flex min-w-0 items-center justify-end gap-2",
        fetching &&
          agents.every((agent) => agent.windows.length === 0) &&
          "animate-pulse",
      )}
    >
      {agents.map((agent) => (
        <UsageChip
          key={`${agent.agentId}:${agent.accountId ?? ""}`}
          usage={agent}
          accounts={accounts}
          showProfile={(counts.get(agent.agentId) ?? 0) > 1}
          active={activeKey === `${agent.agentId}:${agent.accountId ?? ""}`}
        />
      ))}
    </div>
  );
}

function UsageChip({
  usage,
  accounts,
  showProfile,
  active,
}: {
  usage: AgentUsage;
  accounts: AgentAccount[];
  showProfile: boolean;
  active: boolean;
}) {
  const accent = agentAccent(usage.accent);
  const tightest = tightestWindow(usage.windows);
  const used = tightest?.usedPercent ?? 0;
  const hot = used >= 90;
  const fill = hot ? "var(--keel-dead)" : accent;
  const profile = profileLabel(usage.accountId, accounts);

  return (
    <div className="group relative shrink-0">
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-[var(--keel-r-chip)] px-1 py-0.5",
          active && "bg-veil",
        )}
      >
        <span
          className="font-mono text-[10px] font-medium leading-none tracking-wide"
          style={{ color: accent }}
        >
          {usage.short}
        </span>
        {showProfile ? (
          <span className="max-w-16 truncate text-[11px] leading-none text-faint">
            {profile}
          </span>
        ) : null}
        {tightest ? (
          <>
            <span className="h-[4px] w-8 overflow-hidden rounded-full bg-veil">
              <span
                className="block h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${Math.min(100, Math.max(0, used))}%`,
                  background: fill,
                }}
              />
            </span>
            <span
              className={cn(
                "font-mono text-[11px] tabular-nums leading-none",
                hot ? "text-dead" : "text-dim",
              )}
            >
              {formatPercent(used)} {tightest.label}
            </span>
          </>
        ) : (
          <span className="font-mono text-[11px] leading-none text-faint">—</span>
        )}
      </div>

      <div className="pointer-events-none absolute bottom-[calc(100%+8px)] right-0 z-40 hidden w-max min-w-[180px] group-hover:block">
        <UsageCard
          usage={usage}
          accent={accent}
          profile={profile}
          showProfile={showProfile}
        />
      </div>
    </div>
  );
}

function UsageCard({
  usage,
  accent,
  profile,
  showProfile,
}: {
  usage: AgentUsage;
  accent: string;
  profile: string;
  showProfile: boolean;
}) {
  const now = useNow(usage.windows);
  return (
    <div className="k-glass rounded-[var(--keel-r-control)] border border-line px-2.5 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-foreground">
          {usage.name}
          {showProfile ? (
            <span className="text-faint"> · {profile}</span>
          ) : null}
        </span>
        {usage.plan ? (
          <span className="font-mono text-[10px] uppercase tracking-wide text-faint">
            {usage.plan}
          </span>
        ) : null}
      </div>
      {usage.windows.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-1">
          {usage.windows.map((window) => (
            <WindowRow
              key={window.label}
              window={window}
              accent={accent}
              now={now}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-[11px] text-faint">
          {usage.error ?? "Sign in to this agent to see usage"}
        </p>
      )}
    </div>
  );
}

function WindowRow({
  window,
  accent,
  now,
}: {
  window: UsageWindow;
  accent: string;
  now: number;
}) {
  const hot = window.usedPercent >= 90;
  const fill = hot ? "var(--keel-dead)" : accent;
  const reset = formatReset(window.resetsAt, now);
  return (
    <li className="flex items-center gap-2">
      <span className="w-8 shrink-0 font-mono text-[10px] text-faint">
        {window.label}
      </span>
      <span className="h-[3px] w-[72px] overflow-hidden rounded-full bg-veil">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${Math.min(100, Math.max(0, window.usedPercent))}%`,
            background: fill,
          }}
        />
      </span>
      <span
        className={cn(
          "w-8 shrink-0 text-right font-mono text-[11px] tabular-nums",
          hot ? "text-dead" : "text-dim",
        )}
      >
        {formatPercent(window.usedPercent)}
      </span>
      {reset ? (
        <span className="font-mono text-[10px] tabular-nums text-faint">
          {reset}
        </span>
      ) : null}
    </li>
  );
}

function useNow(windows: UsageWindow[]): number {
  const needsTick = windows.some((window) => window.resetsAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!needsTick) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [needsTick]);
  return now;
}
