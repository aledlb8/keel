/**
 * An agent's identity, drawn rather than spelled.
 *
 * Two-letter badges ("CC", "GR") read as placeholder text. Known agents get a
 * small geometric mark instead; anything else — a custom catalogue entry — gets
 * the first letter of its name set in the UI face. Plain shells get a prompt.
 *
 * `tile` sits the glyph on a soft wash of the agent's colour, for places that
 * want an avatar. `glyph` is the bare mark, for dense rows.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const MARKS: Record<string, ReactNode> = {
  // A starburst.
  claude: (
    <g {...STROKE}>
      <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
    </g>
  ),
  // Three interlocking loops.
  codex: (
    <g {...STROKE} strokeWidth={1.8}>
      <rect x="8" y="3" width="8" height="18" rx="4" />
      <rect x="8" y="3" width="8" height="18" rx="4" transform="rotate(60 12 12)" />
      <rect x="8" y="3" width="8" height="18" rx="4" transform="rotate(-60 12 12)" />
    </g>
  ),
  // A four-point sparkle.
  gemini: (
    <path
      fill="currentColor"
      d="M12 2c.6 5.2 4.8 9.4 10 10-5.2.6-9.4 4.8-10 10-.6-5.2-4.8-9.4-10-10 5.2-.6 9.4-4.8 10-10Z"
    />
  ),
  // An open ring cut by a stroke.
  grok: (
    <g {...STROKE}>
      <path d="M17.5 7.5A7 7 0 1 0 19 12" />
      <path d="M20 4 6 20" />
    </g>
  ),
  opencode: (
    <g {...STROKE}>
      <path d="M8 4H5v16h3M16 4h3v16h-3" />
    </g>
  ),
  "cursor-agent": (
    <path
      fill="currentColor"
      d="M5 3.5 20 10l-6.6 2.2L11 19Z"
    />
  ),
  shell: (
    <g {...STROKE}>
      <path d="m6 8 4 4-4 4M13 16h5" />
    </g>
  ),
};

export interface AgentMarkProps {
  /** Catalogue id, or null for a plain shell. */
  agentId: string | null | undefined;
  /** Used for the letter fallback. */
  name?: string;
  accent: string;
  /** Outer size in px. */
  size?: number;
  variant?: "tile" | "glyph";
  muted?: boolean;
  className?: string;
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
  const mark = MARKS[agentId ?? "shell"];
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
      {mark ? (
        <svg width={glyph} height={glyph} viewBox="0 0 24 24">
          {mark}
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
