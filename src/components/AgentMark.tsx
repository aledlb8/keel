/**
 * An agent's identity, drawn rather than spelled.
 *
 * Two-letter badges ("CC", "GR") read as placeholder text. Known agents get
 * their own logo (see agentLogos); anything else — a custom catalogue entry —
 * gets the first letter of its name set in the UI face. Plain shells get a
 * prompt.
 *
 * `tile` sits the glyph on a soft wash of the agent's colour, for places that
 * want an avatar. `glyph` is the bare mark, for dense rows.
 */

import { useId } from "react";

import { AGENT_LOGOS } from "@/components/agentLogos";
import { markFor } from "@/lib/agentMark";
import { cn } from "@/lib/utils";

export interface AgentMarkProps {
  /** Catalogue id, or null for a plain shell. */
  agentId: string | null | undefined;
  /** Used for the letter fallback. */
  name?: string | undefined;
  accent: string;
  /** Outer size in px. */
  size?: number | undefined;
  variant?: "tile" | "glyph" | undefined;
  muted?: boolean | undefined;
  className?: string | undefined;
}

export function AgentMark({
  agentId,
  name,
  accent,
  size = 16,
  variant = "tile",
  muted,
  className,
}: AgentMarkProps) {
  const logo = markFor(AGENT_LOGOS, agentId);
  const uid = useId();
  const tile = variant === "tile";
  const glyph = tile ? Math.round(size * 0.58) : size;
  const letter = (name?.trim()[0] ?? "?").toUpperCase();

  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid shrink-0 place-items-center transition-opacity",
        muted && "opacity-45",
        className,
      )}
      style={{
        width: size,
        height: size,
        color: accent,
        ...(tile
          ? {
              borderRadius: Math.max(4, Math.round(size * 0.3)),
              background: `color-mix(in srgb, ${accent} 14%, transparent)`,
              boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} 22%, transparent)`,
            }
          : null),
      }}
    >
      {logo ? (
        <svg
          viewBox={logo.viewBox}
          // Sized inline: menus size every bare svg in an item with a class,
          // which would win over width and height attributes.
          style={{
            width: glyph,
            height: glyph,
            ...(logo.ink === "accent" ? null : { color: "var(--foreground)" }),
          }}
        >
          {logo.draw(uid)}
        </svg>
      ) : (
        <span
          className="font-semibold leading-none"
          style={{ fontSize: Math.round(glyph * 0.95) }}
        >
          {letter}
        </span>
      )}
    </span>
  );
}
