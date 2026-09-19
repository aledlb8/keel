/**
 * What the two docks share: the fold toggle, the seam you drag to set their
 * width, the rail's tooltips, and the quiet notice a dock shows when it has
 * nothing to list.
 *
 * The docks themselves are `Sidebar` (left) and `Inspector` (right). Their shape
 * — a floating card, inset like a pane, that narrows to a rail — is `.k-dock` in
 * index.css.
 */

import {
  useCallback,
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { LucideIcon } from "lucide-react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

export type DockSide = "left" | "right";

/** How wide a dock opens, and how far it can be dragged either way. */
interface DockRange {
  /** What it opens at, and what a double-click puts it back to. */
  initial: number;
  min: number;
  max: number;
}

/**
 * The numbers live here rather than in the stylesheet because the seam has to
 * know what it is starting from; `.k-dock` reads the answer back out of
 * `--dock-width`. The rail's width stays in CSS — that one is not yours to
 * drag.
 */
const DOCK_WIDTH: Record<DockSide, DockRange> = {
  left: { initial: 248, min: 200, max: 440 },
  // Git paths want the extra characters, so the right one starts wider.
  right: { initial: 288, min: 240, max: 560 },
};

/** Where a dragged width is remembered. */
const WIDTH_KEY: Record<DockSide, string> = {
  left: "keel.dock.left",
  right: "keel.dock.right",
};

/** How far one arrow key moves the seam. */
const WIDTH_STEP = 16;

/** The most of the window a dock may take, however hard you drag. */
const WIDTH_SHARE = 0.4;

/** How long after the last change a width is written down. */
const SAVE_DELAY_MS = 300;

function clampWidth(side: DockSide, width: number): number {
  const { min, max } = DOCK_WIDTH[side];
  const room =
    typeof window === "undefined"
      ? max
      : Math.max(min, Math.round(window.innerWidth * WIDTH_SHARE));
  return Math.round(Math.min(Math.min(max, room), Math.max(min, width)));
}

/**
 * A dock's width, remembered across sessions. A view preference, so it lives
 * with the window rather than in the saved projects — the same as whether the
 * dock is folded at all. Resizing to `null` puts it back to its default.
 */
export function useDockWidth(side: DockSide) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY[side]));
      return saved > 0 ? clampWidth(side, saved) : DOCK_WIDTH[side].initial;
    } catch {
      return DOCK_WIDTH[side].initial;
    }
  });

  // Written once the drag settles — a pointer drag moves this every frame.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(WIDTH_KEY[side], String(width));
      } catch {
        // Storage unavailable: the choice just lasts for this session.
      }
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [side, width]);

  // A window that shrinks takes the dock with it, so a width chosen on a
  // larger screen can never squeeze the canvas out on a smaller one.
  useEffect(() => {
    const shrink = () => setWidth((current) => clampWidth(side, current));
    window.addEventListener("resize", shrink);
    return () => window.removeEventListener("resize", shrink);
  }, [side]);

  const resize = useCallback(
    (next: number | null) =>
      setWidth(next === null ? DOCK_WIDTH[side].initial : clampWidth(side, next)),
    [side],
  );

  return [width, resize] as const;
}

/**
 * The seam between a dock and the canvas, dragged to set that dock's width.
 *
 * It sits in the gutter that is already there and takes no room of its own, so
 * the air between a dock and the nearest pane is the same whether you ever
 * touch it or not. It draws nothing until you reach for it and then shows the
 * same hairline the seams between two panes do: resizing is one gesture in
 * this app, not two. Double-click, or Home with it focused, puts the dock back
 * to the width it opened at.
 *
 * Focused from the keyboard it lights that hairline rather than drawing a
 * ring: a ring around something zero pixels wide would land beside the grip
 * instead of on it.
 */
export function DockSeam({
  side,
  what,
  width,
  onResize,
  onResizing,
}: {
  side: DockSide;
  /** What is being resized, for the label: "the projects dock". */
  what: string;
  width: number;
  onResize: (width: number | null) => void;
  /** Held down, so the dock can drop its fold transition and track the cursor. */
  onResizing: (resizing: boolean) => void;
}) {
  const { min, max } = DOCK_WIDTH[side];

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // No preventDefault: that would suppress the compatibility mouse events
    // this element's own double-click is built on. `data-no-select` is what
    // keeps a drag from selecting anything.
    const handle = event.currentTarget;
    const from = width;
    const origin = event.clientX;
    handle.setPointerCapture(event.pointerId);
    onResizing(true);

    const move = (moved: PointerEvent) => {
      const delta =
        side === "left" ? moved.clientX - origin : origin - moved.clientX;
      onResize(from + delta);
    };
    const stop = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      onResizing(false);
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  return (
    <div
      data-no-select
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${what}`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={startDrag}
      onDoubleClick={() => onResize(null)}
      onKeyDown={(event) => {
        // The arrow that widens is the one pointing away from the dock.
        const toward = side === "left" ? 1 : -1;
        if (event.key === "ArrowRight") onResize(width + WIDTH_STEP * toward);
        else if (event.key === "ArrowLeft") onResize(width - WIDTH_STEP * toward);
        else if (event.key === "Home") onResize(null);
        else return;
        event.preventDefault();
      }}
      className="group/seam relative z-10 w-0 shrink-0 cursor-col-resize outline-none"
    >
      {/* The reach straddles the gutter; the seam itself takes no width, so
          the air around a dock is the same whether you use it or not. */}
      <span
        aria-hidden
        className="absolute inset-y-0 -left-[6px] grid w-3 place-items-center"
      >
        <span className="h-8 w-0.5 rounded-full bg-line-strong opacity-0 transition-opacity duration-100 group-hover/seam:opacity-100 group-focus-visible/seam:bg-[color:var(--keel-focus)] group-focus-visible/seam:opacity-100" />
      </span>
    </div>
  );
}

/**
 * Fold and unfold. A panel outline with a chevron inside it, drawn here rather
 * than swapping two icons, so the chevron can turn instead of blinking. Each
 * side draws its chevron pointing the way that dock folds.
 */
export function DockToggle({
  side,
  collapsed,
  what,
  onToggle,
}: {
  side: DockSide;
  collapsed: boolean;
  /** What folds, for the label: "sidebar", "files and git". */
  what: string;
  onToggle: () => void;
}) {
  const label = `${collapsed ? "Expand" : "Collapse"} ${what}`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="k-icon-btn k-dock-toggle size-6"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <rect x="3" y="3.5" width="18" height="17" rx="3.5" />
        {side === "left" ? (
          <>
            <path d="M9 3.5v17" />
            <path className="k-chevron" d="m16 9.5-2.5 2.5 2.5 2.5" />
          </>
        ) : (
          <>
            <path d="M15 3.5v17" />
            <path className="k-chevron" d="m8 9.5 2.5 2.5-2.5 2.5" />
          </>
        )}
      </svg>
    </button>
  );
}

/** One provider per rail, so moving between tiles skips the delay. */
export function RailTipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={200} skipDelayDuration={400}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

/** A name beside a rail tile, on the canvas side, in the chrome's own colours. */
export function RailTip({
  label,
  detail,
  side = "right",
  children,
}: {
  label: string;
  detail?: string | undefined;
  side?: "left" | "right" | undefined;
  children: ReactNode;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={12}
          collisionPadding={8}
          className={cn(
            "k-tip-surface z-50 flex items-center gap-2 px-2 py-1 duration-150 animate-in fade-in-0",
            side === "right" ? "slide-in-from-left-1" : "slide-in-from-right-1",
          )}
        >
          {label}
          {detail ? (
            <span className="text-small tabular-nums text-faint">{detail}</span>
          ) : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/**
 * Nothing to show, said once and quietly: a glyph on a small raised tile, a
 * line saying what is going on, and at most one line more saying why.
 */
export function DockNotice({
  icon: Icon,
  title,
  detail,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  detail?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 text-center", className)}>
      <span className="grid size-9 place-items-center rounded-[var(--keel-r-control)] bg-veil-2 shadow-[inset_0_1px_0_0_var(--keel-sheen)]">
        <Icon aria-hidden className="size-4 text-dim" />
      </span>
      <p className="mt-3 text-row text-dim">{title}</p>
      {detail ? (
        <p className="mt-1 max-w-[220px] text-body leading-relaxed text-faint">
          {detail}
        </p>
      ) : null}
      {children}
    </div>
  );
}
