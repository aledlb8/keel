/**
 * The bar along the bottom edge: workspaces on the left, state on the right.
 *
 * This replaces the old vertical deck rail. The rail was a third floating column
 * wedged between the sidebar and the canvas, and it cost the layout a whole
 * vertical band to show at most nine numbers. Docked along the bottom the same
 * numbers cost nothing, and the leftover width pays for the two things worth
 * knowing at a glance — where you are, and how many agents are busy.
 *
 * The deck numbers sit in a recessed track. Grouping them inside one sunken
 * shape is what says "these are the tabs" without drawing a border around each.
 */

import { Grid2X2, Plus } from "lucide-react";

import { StatusDot } from "@/components/StatusDot";
import { cn } from "@/lib/utils";
import type { Deck, PaneStatus, Project } from "@/lib/types";
import { deckAttention } from "@/state/store";

const ATTENTION_COLOR: Record<Exclude<PaneStatus, "idle">, string> = {
  working: "var(--keel-working)",
  waiting: "var(--keel-waiting)",
  exited: "var(--keel-dead)",
};

const COUNTER_LABEL: Record<Exclude<PaneStatus, "idle">, string> = {
  working: "working",
  waiting: "waiting for you",
  exited: "exited",
};

export interface StatusBarProps {
  project: Project | null;
  /** The path the focused terminal is sitting in, if there is one. */
  cwd: string | null;
  agentName: string;
  status: Record<string, PaneStatus>;
  /** Every live pane id in the app, for the counters on the right. */
  paneIds: string[];
  onSelectDeck: (deckId: string) => void;
  onAddDeck: () => void;
  onOverview: () => void;
}

/**
 * Paths in a status bar are for orientation, not for copying: keep the last few
 * segments and drop the rest, in the shape a shell prompt would use.
 */
function shortenPath(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const tail = parts.filter(Boolean).slice(-3);
  if (tail.length === 0) return path;
  return (parts.length > tail.length ? "…/" : "") + tail.join("/");
}

export function StatusBar({
  project,
  cwd,
  agentName,
  status,
  paneIds,
  onSelectDeck,
  onAddDeck,
  onOverview,
}: StatusBarProps) {
  // Decks stay invisible until there is a second one to switch between.
  const decks = project && project.decks.length >= 2 ? project.decks : null;

  const counts: Record<Exclude<PaneStatus, "idle">, number> = {
    working: 0,
    waiting: 0,
    exited: 0,
  };
  for (const paneId of paneIds) {
    const state = status[paneId];
    if (state && state !== "idle") counts[state] += 1;
  }
  const live = (
    ["waiting", "working", "exited"] as Exclude<PaneStatus, "idle">[]
  ).filter((state) => counts[state] > 0);

  return (
    <footer className="k-glass relative z-30 flex min-w-0 shrink-0 flex-col border-t border-line pl-2 pr-3.5">
      <div className="flex h-[29px] items-center gap-2.5">
        {decks ? (
          <>
            <button
              type="button"
              title="Overview (Alt+Shift+Space)"
              aria-label="Overview"
              onClick={onOverview}
              className="k-icon-btn size-[22px]"
            >
              <Grid2X2 className="size-3.5" />
            </button>

            <div className="flex items-center gap-0.5 rounded-[var(--keel-r-control)] bg-veil p-0.5">
              {decks.map((deck, index) => (
                <DeckPill
                  key={deck.id}
                  deck={deck}
                  index={index}
                  active={deck.id === project!.activeDeckId}
                  status={status}
                  onSelect={() => onSelectDeck(deck.id)}
                />
              ))}
              <button
                type="button"
                title="New deck (Alt+Shift+Enter)"
                aria-label="New deck"
                onClick={onAddDeck}
                className="k-icon-btn size-[20px]"
              >
                <Plus className="size-3" />
              </button>
            </div>

            <span aria-hidden className="h-3.5 w-px bg-line" />
          </>
        ) : null}

        {cwd ? (
          <span
            className="min-w-0 truncate font-mono text-[11px] text-faint"
            title={cwd}
          >
            {shortenPath(cwd)}
          </span>
        ) : null}

        <span className="flex-1" />

        <div className="flex shrink-0 items-center gap-3.5">
          {live.map((state) => (
            <span
              key={state}
              className="flex items-center gap-1.5 text-[12px] text-dim"
              title={`${counts[state]} ${COUNTER_LABEL[state]}`}
            >
              <StatusDot status={state} size={5} />
              <span className="font-mono tabular-nums text-foreground">
                {counts[state]}
              </span>
              {COUNTER_LABEL[state]}
            </span>
          ))}
        </div>
      </div>

      <div className="flex h-5 min-w-0 items-center gap-1.5 text-[11px] text-faint">
        <span className="shrink-0">Agent:</span>
        <span className="min-w-0 truncate text-dim" title={agentName}>
          {agentName}
        </span>
      </div>
    </footer>
  );
}

function DeckPill({
  deck,
  index,
  active,
  status,
  onSelect,
}: {
  deck: Deck;
  index: number;
  active: boolean;
  status: Record<string, PaneStatus>;
  onSelect: () => void;
}) {
  const attention = deckAttention(deck, status);
  // A deck you are not looking at says so by colouring its own number. That is
  // cheaper than hanging a dot off a 20px pill, and colour already means state
  // everywhere else in the app.
  const tint = !active && attention ? ATTENTION_COLOR[attention] : undefined;

  return (
    <button
      type="button"
      title={`${deck.name}${index < 9 ? ` (Alt+Shift+${index + 1})` : ""}`}
      onClick={onSelect}
      className={cn(
        "h-[20px] min-w-[20px] rounded-[var(--keel-r-chip)] px-1.5 font-mono text-[11px] tabular-nums transition-colors",
        active
          ? "bg-veil-3 text-foreground shadow-[inset_0_1px_0_0_var(--keel-sheen)]"
          : "text-faint hover:bg-veil-2 hover:text-foreground",
      )}
      style={tint ? { color: tint } : undefined}
    >
      {index + 1}
    </button>
  );
}
