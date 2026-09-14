/**
 * What an agent is doing, in six pixels.
 *
 * This is the only place in the app that spends colour on status, and it only
 * appears in the sidebar: amber while an agent is working, green once it has
 * finished and you have not been back to it. Everything else — idle agents and
 * plain shells alike — is a neutral grey.
 */

import { cn } from "@/lib/utils";
import type { PaneStatus } from "@/lib/types";

const STATUS_COLOR: Record<PaneStatus, string> = {
  working: "var(--keel-working)",
  done: "var(--keel-done)",
  idle: "var(--keel-idle)",
};

export const STATUS_LABEL: Record<PaneStatus, string | undefined> = {
  working: "Working",
  done: "Done",
  idle: undefined,
};

export interface StatusDotProps {
  status: PaneStatus;
  /** Overrides the default 6px. */
  size?: number;
  className?: string;
}

export function StatusDot({ status, size = 6, className }: StatusDotProps) {
  return (
    <span
      aria-hidden
      title={STATUS_LABEL[status]}
      style={{ background: STATUS_COLOR[status], width: size, height: size }}
      className={cn("shrink-0 rounded-full", className)}
    />
  );
}
