/**
 * What a terminal is doing, in six pixels.
 *
 * This is the most-repeated mark in the app — it appears on every sidebar row,
 * every deck tab and every cell of a schematic — so it is one component rather
 * than four hand-rolled spans that drifted apart.
 *
 * Only `waiting` animates. An agent that has stopped to ask you something is the
 * single event this window exists to surface, and giving it the only motion on
 * screen is what makes it findable without hunting. Everything else holds still;
 * a screen where six things pulse is a screen where none of them mean anything.
 */

import { cn } from "@/lib/utils";
import type { PaneStatus } from "@/lib/types";

/** `idle` has no colour of its own — it falls back to the agent's accent. */
const STATUS_COLOR: Record<PaneStatus, string | null> = {
  working: "var(--keel-working)",
  waiting: "var(--keel-waiting)",
  exited: "var(--keel-dead)",
  idle: null,
};

export interface StatusDotProps {
  status: PaneStatus;
  /** Colour for `idle`, normally the agent's accent. */
  fallback?: string;
  /** Overrides the default 6px, for the smaller marks in a schematic. */
  size?: number;
  title?: string;
  className?: string;
}

export function StatusDot({
  status,
  fallback,
  size = 6,
  title,
  className,
}: StatusDotProps) {
  const color = STATUS_COLOR[status] ?? fallback ?? "var(--keel-idle)";

  return (
    <span
      aria-hidden
      title={title}
      // `color` rather than `background` so the pulse ring, which is drawn with
      // `currentColor`, tracks the dot without being told the value twice.
      style={{ color, background: color, width: size, height: size }}
      className={cn(
        "relative shrink-0 rounded-full",
        status === "waiting" && "k-pulse",
        className,
      )}
    />
  );
}
