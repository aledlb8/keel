/**
 * What the two docks share: the fold toggle, the rail's tooltips, and the quiet
 * notice a dock shows when it has nothing to list.
 *
 * The docks themselves are `Sidebar` (left) and `Inspector` (right). Their shape
 * — a floating card, inset like a pane, that narrows to a rail — is `.k-dock` in
 * index.css.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

export type DockSide = "left" | "right";

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
  detail?: string;
  side?: "left" | "right";
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
            <span className="text-[11px] tabular-nums text-faint">{detail}</span>
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
      <p className="mt-3 text-[13px] text-dim">{title}</p>
      {detail ? (
        <p className="mt-1 max-w-[220px] text-[12px] leading-relaxed text-faint">
          {detail}
        </p>
      ) : null}
      {children}
    </div>
  );
}
