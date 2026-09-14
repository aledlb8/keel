/**
 * Quota for every signed-in login, polled in the background.
 *
 * Only logins with real numbers are handed out. One that has not answered yet,
 * or whose answer was an error or empty, is simply absent — the footer never
 * draws a blank gauge or a dash while it waits. One that did answer keeps its
 * last good reading through a failed poll, so a flaky request does not make it
 * blink out; it only goes once that reading is properly stale.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { invoke } from "@/lib/invoke";
import { activeDeck, useKeel } from "@/state/store";
import type { AgentAccount, Pane, Project } from "@/lib/types";
import {
  USAGE_POLL_MS,
  buildUsageQueries,
  retainUsage,
  usageKey,
  usageQueryKey,
  isReady,
  type AgentUsage,
  type KeptUsage,
  type UsageSnapshot,
} from "@/lib/usage";

function focusedPaneOf(
  projects: Project[],
  activeProjectId: string | null,
): Pane | null {
  const project = projects.find((item) => item.id === activeProjectId) ?? null;
  const deck = activeDeck(project);
  return deck?.focused ? (deck.panes[deck.focused] ?? null) : null;
}

export function useAgentUsage(): {
  /** Logins with a good reading, in catalogue order. */
  agents: AgentUsage[];
  fetching: boolean;
  /** When a poll last brought back good numbers. */
  fetchedAt: number | null;
  accounts: AgentAccount[];
  /** `usageKey` of the login the focused terminal is using. */
  activeKey: string;
  refresh: () => void;
} {
  const agents = useKeel((state) => state.agents);
  const accounts = useKeel((state) => state.accounts);
  const projects = useKeel((state) => state.projects);
  const activeProjectId = useKeel((state) => state.activeProjectId);
  const [kept, setKept] = useState<Map<string, KeptUsage>>(() => new Map());
  const [fetching, setFetching] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const pullNow = useRef<() => void>(() => {});

  const focused = useMemo(
    () => focusedPaneOf(projects, activeProjectId),
    [projects, activeProjectId],
  );
  const activeKey = usageKey(focused?.agentId ?? "", focused?.accountId);

  const query = useMemo(
    () => buildUsageQueries(agents, accounts),
    [agents, accounts],
  );
  const key = usageQueryKey(query);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    const live = new Set(
      queryRef.current.map((item) => usageKey(item.id, item.accountId)),
    );
    // A login that is no longer asked about leaves at once.
    setKept((previous) => retainUsage(previous, [], Date.now(), live));
    if (live.size === 0) return;

    let cancelled = false;
    let inFlight = false;

    const pull = async () => {
      if (inFlight) return;
      inFlight = true;
      setFetching(true);
      try {
        const next = await invoke<UsageSnapshot | null>("usage_fetch", {
          agents: queryRef.current,
        });
        if (cancelled) return;
        const fresh = next?.agents ?? [];
        const now = Date.now();
        setKept((previous) => retainUsage(previous, fresh, now, live));
        if (fresh.some(isReady)) setFetchedAt(now);
      } catch {
        // Keep what is on screen; it ages out by itself if this persists.
        if (!cancelled) {
          setKept((previous) => retainUsage(previous, [], Date.now(), live));
        }
      } finally {
        inFlight = false;
        if (!cancelled) setFetching(false);
      }
    };

    pullNow.current = () => void pull();
    void pull();
    const interval = setInterval(() => void pull(), USAGE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void pull();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      pullNow.current = () => {};
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key]);

  const ready = useMemo(
    () =>
      query.flatMap((item) => {
        const entry = kept.get(usageKey(item.id, item.accountId));
        return entry ? [entry.usage] : [];
      }),
    [query, kept],
  );

  const refresh = useCallback(() => pullNow.current(), []);

  return {
    agents: ready,
    fetching,
    fetchedAt,
    accounts,
    activeKey,
    refresh,
  };
}
