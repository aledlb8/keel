/**
 * The bar along the bottom edge: workspaces, where you are, and remaining quota.
 *
 * This replaces the old vertical deck rail. The rail was a third floating column
 * wedged between the sidebar and the canvas, and it cost the layout a whole
 * vertical band to show at most nine numbers. Docked along the bottom the same
 * numbers cost nothing.
 *
 * The deck numbers sit in a recessed track. Grouping them inside one sunken
 * shape is what says "these are the tabs" without drawing a border around each.
 * Subscription meters dock on the right, one chip per signed-in agent.
 */

import { Grid2X2, Plus } from "lucide-react";

import { UsageMeter } from "@/components/UsageMeter";
import { StatusLight, vpnView } from "@/components/VpnDialog";
import { withShortcut } from "@/lib/keymap";
import { cn } from "@/lib/utils";
import type { Deck, Project } from "@/lib/types";
import { useKeel } from "@/state/store";

export interface StatusBarProps {
  project: Project | null;
  /** The path the focused terminal is sitting in, if there is one. */
  cwd: string | null;
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
  onSelectDeck,
  onAddDeck,
  onOverview,
}: StatusBarProps) {
  // Decks stay invisible until there is a second one to switch between.
  const decks = project && project.decks.length >= 2 ? project.decks : null;

  return (
    <footer className="k-glass relative z-30 flex h-[32px] min-w-0 shrink-0 items-center gap-2.5 overflow-visible border-t border-line pl-2 pr-3.5">
      {decks ? (
        <>
          <button
            type="button"
            title={withShortcut("Overview", "overview")}
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
                onSelect={() => onSelectDeck(deck.id)}
              />
            ))}
            <button
              type="button"
              title={withShortcut("New deck", "newDeck")}
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

      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <VpnChip />
        {/* Brings its own divider, so there is none when it has nothing to show. */}
        <UsageMeter />
      </div>
    </footer>
  );
}

function DeckPill({
  deck,
  index,
  active,
  onSelect,
}: {
  deck: Deck;
  index: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      title={`${deck.name}${index < 9 ? ` (Ctrl+${index + 1})` : ""}`}
      onClick={onSelect}
      className={cn(
        "h-[20px] min-w-[20px] rounded-[var(--keel-r-chip)] px-1.5 text-[11px] font-medium tabular-nums transition-colors",
        active
          ? "bg-veil-3 text-foreground shadow-[inset_0_1px_0_0_var(--keel-sheen)]"
          : "text-faint hover:bg-veil-2 hover:text-foreground",
      )}
    >
      {index + 1}
    </button>
  );
}

function VpnChip() {
  const vpn = useKeel((state) => state.vpn);
  const { tone, color, headline } = vpnView(vpn);
  const title =
    tone === "connected" && vpn.profileName
      ? `VPN connected · ${vpn.profileName}`
      : tone === "error" && vpn.error
        ? `VPN: ${vpn.error}`
        : `VPN ${headline.toLowerCase()}`;

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={() => useKeel.getState().openVpnSettings()}
      className={cn(
        "flex h-[22px] shrink-0 items-center gap-2 rounded-[var(--keel-r-chip)] px-2 text-[11px] font-medium transition-colors hover:bg-veil-2 hover:text-foreground",
        tone === "idle" ? "text-faint" : "text-dim",
      )}
    >
      <StatusLight tone={tone} color={color} size={7} />
      VPN
    </button>
  );
}
