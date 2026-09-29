/**
 * Quota for every signed-in login, polled in the background.
 *
 * Only logins with real numbers are handed out. One that has not answered yet,
 * or whose answer was an error or empty, is simply absent — the footer never
 * draws a blank gauge or a dash while it waits. One that did answer keeps its
 * last good reading through a failed poll, so a flaky request does not make it
 * blink out; it only goes once that reading is properly stale.
 *
 * Bringing the private tunnel up or down changes which logins can answer at
 * all, so a poll that ran mid-transition gives only half the picture. A phase
 * that settles onto a new route asks the whole set again right away, instead
 * of leaving the missing logins to appear on the next interval or a manual
 * refresh.
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
  usageRouteChanged,
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
  const vpnPhase = useKeel((state) => state.vpn.phase);

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
    // A poll asked for while one is already running must not be dropped — a
    // VPN that settles mid-poll needs the request to run against the new
    // route the moment the old one finishes.
    let queued = false;

    const pull = async () => {
      if (inFlight) {
        queued = true;
        return;
      }
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
      if (queued && !cancelled) {
        queued = false;
        void pull();
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

  // The tunnel's phase decides whether the backend reaches each vendor
  // directly or through the private proxy. Once a transition settles, the
  // logins that could not answer before get asked again immediately.
  const lastVpnPhase = useRef(vpnPhase);
  useEffect(() => {
    const previous = lastVpnPhase.current;
    lastVpnPhase.current = vpnPhase;
    if (usageRouteChanged(previous, vpnPhase)) pullNow.current();
  }, [vpnPhase]);

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
