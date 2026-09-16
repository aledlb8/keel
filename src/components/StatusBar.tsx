/**
 * The bar along the bottom edge: decks, where you are, and remaining quota.
 *
 * This replaces the old vertical deck rail. The rail was a third floating column
 * wedged between the sidebar and the canvas, and it cost the layout a whole
 * vertical band to show at most nine numbers. Docked along the bottom the same
 * numbers cost nothing.
 *
 * **The left side is one cluster, read left to right: zoom out, which deck,
 * where that deck is standing.** It is ordered by how often each part changes.
 * The overview button never moves, so it is the anchor and it is always there —
 * a project always has at least one deck to look at. The deck track appears
 * beside it once there are two to switch between, which happens when you decide
 * it does. The path comes last because it changes on its own, every time an
 * agent wanders into another folder, and nothing that moves by itself is
 * allowed to push a click target around.
 *
 * The deck numbers sit in the same recessed track as every other set of
 * exclusive options in the app. Grouping them inside one sunken shape is what
 * says "these are the tabs" without drawing a border around each.
 *
 * Subscription meters dock on the right, one chip per signed-in agent.
 */

import { Grid2X2, Plus } from "lucide-react";

import { UsageMeter } from "@/components/UsageMeter";
import { StatusLight, vpnView } from "@/components/VpnDialog";
import { withShortcut } from "@/lib/keymap";
import { statusPlace } from "@/lib/statusPath";
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
    <footer className="k-glass relative z-30 flex h-[32px] min-w-0 shrink-0 items-center gap-2 overflow-visible border-t border-line pl-2 pr-3.5">
      {project ? (
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

          {decks ? (
            <div className="k-seg shrink-0">
              {decks.map((deck, index) => (
                <DeckPill
                  key={deck.id}
                  deck={deck}
                  index={index}
                  active={deck.id === project.activeDeckId}
                  onSelect={() => onSelectDeck(deck.id)}
                />
              ))}
              <button
                type="button"
                title={withShortcut("New deck", "newDeck")}
                aria-label="New deck"
                onClick={onAddDeck}
                className="k-icon-btn size-[18px]"
              >
                <Plus className="size-3" />
              </button>
            </div>
          ) : null}

          <Place project={project} cwd={cwd} />
        </>
      ) : null}

      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <VpnChip />
        {/* Brings its own divider, so there is none when it has nothing to show. */}
        <UsageMeter />
      </div>
    </footer>
  );
}

/**
 * Where the focused terminal is standing, in two voices: the project's name in
 * the UI face because you named it, and the rest of the path in the mono face
 * because the disk did. The change of face is the separator — it needs no glyph
 * and no rule, and it keeps the part that moves visibly subordinate to the part
 * that does not.
 */
function Place({ project, cwd }: { project: Project; cwd: string | null }) {
  const { root, tail } = statusPlace(cwd, project);
  if (!tail) return null;

  return (
    <span
      className="min-w-0 truncate text-[11px] leading-none"
      title={cwd ?? project.path}
    >
      {root ? <span className="text-dim">{root}</span> : null}
      <span className="font-mono text-[10.5px] text-faint">{tail}</span>
    </span>
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
        "h-[18px] min-w-[18px] rounded-[var(--keel-r-chip)] px-1.5 text-[11px] font-medium tabular-nums transition-colors",
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
