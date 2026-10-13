/**
 * The agent board: every agent in Keel, in one small window.
 *
 * For the monitor at the edge of a big setup, or a corner of a small one —
 * what is waiting on you, what is still working, and what is idle, across
 * every project, deck and window. Clicking a row goes to that agent in
 * whichever window it is in. Like a screen it holds no state of its own; it
 * mirrors the main window's.
 */

import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Pin, PinOff, X } from "lucide-react";

import { AgentMark } from "@/components/AgentMark";
import { StatusDot } from "@/components/StatusDot";
import { KeelMark, WindowButton } from "@/components/Titlebar";
import { isBrowserChromeKey } from "@/lib/appShortcuts";
import { paneRefs, sinceLabel, type PaneRef } from "@/lib/island";
import { screenOfDeck } from "@/lib/screens";
import { agentAccent } from "@/lib/tokens";
import type { PaneStatus } from "@/lib/types";
import { startWindowFocusTracking } from "@/lib/windowFocus";
import { useKeel } from "@/state/store";

/** How often "for 3m" moves on. */
const TICK_MS = 15_000;

interface Row extends PaneRef {
  status: PaneStatus;
  since: number | null;
  /** In a window of its own, rather than the main window. */
  away: boolean;
}

export default function BoardApp() {
  const projects = useKeel((state) => state.projects);
  const status = useKeel((state) => state.status);
  const doneAt = useKeel((state) => state.doneAt);
  const agents = useKeel((state) => state.agents);
  const screens = useKeel((state) => state.screens);
  const onTop = useKeel((state) => state.board?.onTop ?? false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    const stopFade = startWindowFocusTracking();
    const blockNativeMenu = (event: MouseEvent) => event.preventDefault();
    const blockChrome = (event: KeyboardEvent) => {
      if (!isBrowserChromeKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("contextmenu", blockNativeMenu);
    window.addEventListener("keydown", blockChrome, true);
    void getCurrentWindow().setTitle("Agents — Keel").catch(() => {});
    return () => {
      clearInterval(timer);
      stopFade();
      window.removeEventListener("contextmenu", blockNativeMenu);
      window.removeEventListener("keydown", blockChrome, true);
    };
  }, []);

  const groups = useMemo(() => {
    const rows: Row[] = paneRefs(projects)
      .filter((ref) => ref.agentId !== null)
      .map((ref) => ({
        ...ref,
        status: status[ref.paneId] ?? "idle",
        since: doneAt[ref.paneId] ?? null,
        away: screenOfDeck(screens, ref.deckId) !== null,
      }));
    const waiting = rows
      .filter((row) => row.status === "done" || row.status === "waiting")
      .sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
    return [
      { title: "Waiting on you", rows: waiting },
      { title: "Working", rows: rows.filter((row) => row.status === "working") },
      { title: "Idle", rows: rows.filter((row) => row.status === "idle") },
    ].filter((group) => group.rows.length > 0);
  }, [projects, status, doneAt, screens]);

  const keel = useKeel.getState;
  const appWindow = getCurrentWindow();

  return (
    <div className="flex h-full flex-col text-foreground">
      <header
        data-tauri-drag-region
        className="k-glass flex h-[38px] shrink-0 items-stretch border-b border-line"
      >
        <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2 pl-3.5">
          <span data-tauri-drag-region className="text-dim">
            <KeelMark />
          </span>
          <span data-tauri-drag-region className="text-row font-medium text-dim">
            Agents
          </span>
        </div>
        <WindowButton
          label={onTop ? "Stop keeping on top" : "Keep on top of other windows"}
          onClick={() => keel().setBoardOnTop(!onTop)}
        >
          {onTop ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </WindowButton>
        <WindowButton label="Minimize" onClick={() => void appWindow.minimize()}>
          <Minus className="size-3.5" />
        </WindowButton>
        <WindowButton label="Close" danger onClick={() => keel().closeBoard()}>
          <X className="size-4" />
        </WindowButton>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups.length === 0 ? (
          <p className="px-3 py-6 text-center text-body text-faint">
            No agents are open. Start one in any project and it shows up here.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.title} className="mb-3">
              <h2 className="px-2 pb-1 pt-1.5 text-small font-medium uppercase tracking-[0.06em] text-faint">
                {group.title} · {group.rows.length}
              </h2>
              <ul className="flex flex-col gap-0.5">
                {group.rows.map((row) => {
                  const agent = agents.find((item) => item.id === row.agentId) ?? null;
                  const where =
                    row.deckCount > 1 ? `${row.projectName} / ${row.deckName}` : row.projectName;
                  return (
                    <li key={row.paneId}>
                      <button
                        type="button"
                        title={`Go to ${row.title}`}
                        onClick={() => keel().jumpToPane(row.paneId)}
                        className="flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left hover:bg-veil-2"
                      >
                        <StatusDot status={row.status} />
                        <AgentMark
                          agentId={row.agentId}
                          name={agent?.name}
                          accent={agentAccent(agent?.accent)}
                          size={16}
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-row text-foreground">{row.title}</span>
                          <span className="truncate text-small text-faint">
                            {where}
                            {row.away ? " · own window" : ""}
                          </span>
                        </span>
                        {row.since !== null ? (
                          <span className="shrink-0 text-small text-faint">
                            {sinceLabel(row.since, now)}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </main>
    </div>
  );
}
