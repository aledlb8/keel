/**
 * Agents that finished and are waiting on you, pulled to the top of the dock.
 *
 * This is the section the whole redesign is for. Running a dozen agents at once,
 * the expensive mistake is not that the tree is untidy — it is that something
 * finished twenty minutes ago three projects away and you never saw it. So the
 * one piece of the sidebar that ignores scope entirely is this one: it lists
 * what is waiting wherever it lives, longest wait first, with the project
 * spelled out so a row from somewhere else still makes sense.
 *
 * It disappears completely when nothing is waiting. A section that is empty
 * most of the time and shouts the rest of the time is worth more than a badge
 * that is always there and therefore never read.
 */

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";

import { AgentMark } from "@/components/AgentMark";
import { StatusDot } from "@/components/StatusDot";
import { paneMenu } from "@/components/menu/actions";
import {
  ContextMenuEntries,
} from "@/components/menu/MenuEntries";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { lookingAt, sinceLabel, waitingPanes } from "@/lib/island";
import { agentAccent } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import { useKeel } from "@/state/store";

/** Past this many, the rest are a count rather than more rows. */
const SHOWN = 5;

export function Attention({ onNavigate }: { onNavigate: () => void }) {
  const projects = useKeel((state) => state.projects);
  const agents = useKeel((state) => state.agents);
  const status = useKeel((state) => state.status);
  const doneAt = useKeel((state) => state.doneAt);
  const activeProjectId = useKeel((state) => state.activeProjectId);
  const [open, setOpen] = useState(true);

  // "4m ago" has to keep counting on its own; nothing else moves in here.
  const [now, setNow] = useState(() => Date.now());
  const waiting = waitingPanes(
    projects,
    status,
    doneAt,
    lookingAt(projects, activeProjectId),
  );
  const count = waiting.length;

  useEffect(() => {
    if (count === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [count]);

  if (count === 0) return null;
  const shown = open ? waiting.slice(0, SHOWN) : [];
  const hidden = count - shown.length;

  return (
    <section className="k-attn" aria-label="Agents waiting">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className="k-attn-head"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-faint transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <span className="flex-1 text-left">Needs you</span>
        <span className="k-count k-count-done">{count}</span>
      </button>

      {shown.map((item) => {
        const agent = agents.find((entry) => entry.id === item.agentId) ?? null;
        return (
          <ContextMenu key={item.paneId}>
            <ContextMenuTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                className="k-row k-row-tall group/pane"
                data-depth={0}
                onClick={() => {
                  useKeel.getState().jumpToPane(item.paneId);
                  onNavigate();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  useKeel.getState().jumpToPane(item.paneId);
                  onNavigate();
                }}
              >
                <StatusDot status="done" />
                <AgentMark
                  agentId={agent?.id ?? item.agentId}
                  name={agent?.name}
                  accent={agentAccent(agent?.accent)}
                  size={16}
                />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-[13px] text-foreground">
                    {item.title}
                  </span>
                  <span className="truncate text-[11px] text-faint">
                    {item.projectName}
                    {item.deckCount > 1 ? ` · ${item.deckName}` : ""}
                  </span>
                </span>
                <span className="shrink-0 pr-0.5 text-[11px] tabular-nums text-faint">
                  {sinceLabel(item.since, now)}
                </span>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuEntries
                entries={() => paneMenu(item.projectId, item.paneId, "sidebar")}
              />
            </ContextMenuContent>
          </ContextMenu>
        );
      })}

      {open && hidden > 0 ? (
        <button
          type="button"
          onClick={() => {
            const paneId = useKeel.getState().jumpToNextWaiting();
            if (paneId) onNavigate();
          }}
          className="k-attn-more"
        >
          {hidden} more waiting
        </button>
      ) : null}
    </section>
  );
}
