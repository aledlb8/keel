import { useEffect, useMemo, useRef, useState } from "react";

import { invoke } from "@/lib/invoke";
import { activeDeck, useKeel } from "@/state/store";
import type { AgentAccount, Pane, Project } from "@/lib/types";
import {
  USAGE_POLL_MS,
  buildUsageQueries,
  usageQueryKey,
  type AgentUsage,
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
  agents: AgentUsage[];
  fetching: boolean;
  accounts: AgentAccount[];
  activeKey: string;
} {
  const agents = useKeel((state) => state.agents);
  const accounts = useKeel((state) => state.accounts);
  const projects = useKeel((state) => state.projects);
  const activeProjectId = useKeel((state) => state.activeProjectId);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [fetching, setFetching] = useState(false);

  const focused = useMemo(
    () => focusedPaneOf(projects, activeProjectId),
    [projects, activeProjectId],
  );
  const activeKey = `${focused?.agentId ?? ""}:${focused?.accountId ?? ""}`;

  const query = useMemo(
    () => buildUsageQueries(agents, accounts),
    [agents, accounts],
  );
  const key = usageQueryKey(query);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    if (queryRef.current.length === 0) {
      setSnapshot({ agents: [], fetchedAt: Date.now() });
      return;
    }

    let cancelled = false;

    const pull = async () => {
      setFetching(true);
      try {
        const next = await invoke<UsageSnapshot>("usage_fetch", {
          agents: queryRef.current,
        });
        if (!cancelled) setSnapshot(next);
      } catch {
        if (!cancelled) {
          setSnapshot(
            (previous) => previous ?? { agents: [], fetchedAt: Date.now() },
          );
        }
      } finally {
        if (!cancelled) setFetching(false);
      }
    };

    void pull();
    const interval = setInterval(() => void pull(), USAGE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void pull();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key]);

  return {
    agents: snapshot?.agents ?? [],
    fetching,
    accounts,
    activeKey,
  };
}
