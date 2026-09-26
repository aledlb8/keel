import type { CSSProperties, ReactNode } from "react";

export type AgentId =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "grok"
  | "cursor-agent"
  | "aider"
  | "crush"
  | "goose"
  | "shell";

export interface AgentInfo {
  id: AgentId;
  name: string;
  accent: string;
  /** Spinner frames shown while the agent is mid-turn. */
  spinner: string[];
  /** Bullet in front of a tool call. */
  bullet: string;
}

/** The built-in catalogue, with the accents the app ships. */
export const AGENTS: Record<AgentId, AgentInfo> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    accent: "#d97757",
    spinner: ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"],
    bullet: "●",
  },
  codex: {
    id: "codex",
    name: "Codex",
    accent: "#10a37f",
    spinner: ["◐", "◓", "◑", "◒"],
    bullet: "•",
  },
  gemini: {
    id: "gemini",
    name: "Gemini CLI",
    accent: "#4285f4",
    spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    bullet: "✦",
  },
  opencode: {
    id: "opencode",
    name: "opencode",
    accent: "#e5c07b",
    spinner: ["▁", "▃", "▅", "▇", "▅", "▃"],
    bullet: "│",
  },
  grok: {
    id: "grok",
    name: "Grok Build",
    accent: "#f5f5f5",
    spinner: ["◜", "◠", "◝", "◞", "◡", "◟"],
    bullet: "›",
  },
  "cursor-agent": {
    id: "cursor-agent",
    name: "Cursor Agent",
    accent: "#a0a0a0",
    spinner: ["⬡", "⬢"],
    bullet: "⬢",
  },
  aider: {
    id: "aider",
    name: "Aider",
    accent: "#8b5cf6",
    spinner: ["░", "▒", "▓", "▒"],
    bullet: "»",
  },
  crush: {
    id: "crush",
    name: "Crush",
    accent: "#ff7ac6",
    spinner: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
    bullet: "◆",
  },
  goose: {
    id: "goose",
    name: "Goose",
    accent: "#38bdf8",
    spinner: ["◢", "◣", "◤", "◥"],
    bullet: "→",
  },
  shell: {
    id: "shell",
    name: "Shell",
    accent: "#8b95a7",
    spinner: ["-"],
    bullet: "$",
  },
};

export const AGENT_ORDER: AgentId[] = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "grok",
  "cursor-agent",
  "aider",
  "crush",
  "goose",
];

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** The same geometric marks the app draws. Unlisted agents get a letter. */
const MARKS: Partial<Record<AgentId, ReactNode>> = {
  claude: (
    <g {...STROKE}>
      <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
    </g>
  ),
  codex: (
    <g {...STROKE} strokeWidth={1.8}>
      <rect x="8" y="3" width="8" height="18" rx="4" />
      <rect x="8" y="3" width="8" height="18" rx="4" transform="rotate(60 12 12)" />
      <rect x="8" y="3" width="8" height="18" rx="4" transform="rotate(-60 12 12)" />
    </g>
  ),
  gemini: (
    <path
      fill="currentColor"
      d="M12 2c.6 5.2 4.8 9.4 10 10-5.2.6-9.4 4.8-10 10-.6-5.2-4.8-9.4-10-10 5.2-.6 9.4-4.8 10-10Z"
    />
  ),
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
  "cursor-agent": <path fill="currentColor" d="M5 3.5 20 10l-6.6 2.2L11 19Z" />,
  shell: (
    <g {...STROKE}>
      <path d="m6 8 4 4-4 4M13 16h5" />
    </g>
  ),
};

export function AgentMark({
  agent,
  size = 16,
  variant = "tile",
  className,
  style,
  fluid = false,
}: {
  agent: AgentId;
  size?: number;
  variant?: "tile" | "glyph";
  className?: string;
  style?: CSSProperties;
  /** Size to the surrounding text instead of in pixels. */
  fluid?: boolean;
}) {
  const info = AGENTS[agent];
  const mark = MARKS[agent];
  const tile = variant === "tile";
  const glyph = tile ? Math.round(size * 0.58) : size;
  const accent = info.accent;
  return (
    <span
      aria-hidden
      className={`inline-grid shrink-0 place-items-center ${className ?? ""}`}
      style={{
        width: fluid ? "0.62em" : size,
        height: fluid ? "0.62em" : size,
        color: fluid ? "inherit" : accent,
        ...(tile
          ? {
              borderRadius: Math.max(4, Math.round(size * 0.3)),
              background: `color-mix(in srgb, ${accent} 14%, transparent)`,
              boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} 22%, transparent)`,
            }
          : null),
        ...style,
      }}
    >
      {mark ? (
        <svg
          width={fluid ? "100%" : glyph}
          height={fluid ? "100%" : glyph}
          viewBox="0 0 24 24"
        >
          {mark}
        </svg>
      ) : (
        <span
          className="leading-none font-semibold"
          style={{ fontSize: fluid ? "0.62em" : Math.round(glyph * 0.95) }}
        >
          {info.name[0]!.toUpperCase()}
        </span>
      )}
    </span>
  );
}

/**
 * The hull in section, cut off at the deck line — the app's own mark. A keel is
 * the spine a boat is built out from: one structure holding separate work
 * upright.
 */
export function KeelMark({
  size = 14,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 13 13"
      fill="none"
      aria-hidden
      className={`shrink-0 ${className ?? ""}`}
    >
      <path
        d="M1.5 3.25H11.5V6.25C11.5 9.01142 9.26142 11.25 6.5 11.25C3.73858 11.25 1.5 9.01142 1.5 6.25V3.25Z"
        fill="currentColor"
        fillOpacity="0.92"
      />
      <path
        d="M6.5 3.25V11.25"
        stroke="#050505"
        strokeOpacity="0.6"
        strokeWidth="1"
      />
    </svg>
  );
}

export const STATUS_COLOR = {
  working: "var(--k-working)",
  done: "var(--k-done)",
  idle: "var(--k-idle)",
} as const;

export type PaneStatus = keyof typeof STATUS_COLOR;

export function StatusDot({
  status,
  size = 6,
}: {
  status: PaneStatus;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      className={`shrink-0 rounded-full ${status === "working" ? "pulse-dot" : ""}`}
      style={{ width: size, height: size, background: STATUS_COLOR[status] }}
    />
  );
}

/** Balanced rows: at most ceil(sqrt(n)) columns, row lengths differ by one. */
export function gridRows(count: number): number[] {
  if (count <= 0) return [];
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const base = Math.floor(count / rows);
  const extra = count % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rectangles, in reading order, for `count` panes inside `width × height`. */
export function gridRects(
  count: number,
  width: number,
  height: number,
  gap: number,
): Rect[] {
  const rows = gridRows(count);
  const rh = (height - gap * (rows.length - 1)) / rows.length;
  const out: Rect[] = [];
  rows.forEach((n, r) => {
    const cw = (width - gap * (n - 1)) / n;
    for (let c = 0; c < n; c++) {
      out.push({ x: c * (cw + gap), y: r * (rh + gap), w: cw, h: rh });
    }
  });
  return out;
}
