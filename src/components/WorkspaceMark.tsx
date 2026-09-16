/**
 * What a workspace looks like, at every size.
 *
 * A workspace is a container: not a folder on disk, not a project, just the box
 * a few projects sit in. So its mark is a box — a chip with a hairline ring —
 * and what is written inside it is the group's own initials. Four anonymous
 * dots said "a group" but never said *which* group, which is the only thing a
 * mark has to say in a 248px dock.
 *
 * The same box with nothing in it yet is `WorkspaceGlyph`: four corners, the
 * way anything is marked as grouped. It goes wherever the app means "a
 * workspace" in general rather than one in particular — the header button, the
 * rail's action, the menus. It is shaped as a lucide icon so it can sit in a
 * menu row beside `Ungroup` and match it stroke for stroke.
 */

import { forwardRef } from "react";
import type { LucideProps } from "lucide-react";

import { monogram } from "@/lib/monogram";
import { cn } from "@/lib/utils";

export const WorkspaceGlyph = forwardRef<SVGSVGElement, LucideProps>(
  function WorkspaceGlyph(
    { size = 24, absoluteStrokeWidth: _absolute, ...props },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...props}
      >
        <path d="M4 9V6.5A2.5 2.5 0 0 1 6.5 4H9" />
        <path d="M15 4h2.5A2.5 2.5 0 0 1 20 6.5V9" />
        <path d="M20 15v2.5a2.5 2.5 0 0 1-2.5 2.5H15" />
        <path d="M9 20H6.5A2.5 2.5 0 0 1 4 17.5V15" />
      </svg>
    );
  },
);

export interface WorkspaceMarkProps {
  name: string;
  /** Outer size in px. */
  size?: number;
  /** You are somewhere inside this group. */
  current?: boolean;
  className?: string;
}

export function WorkspaceMark({
  name,
  size = 18,
  current,
  className,
}: WorkspaceMarkProps) {
  return (
    <span
      aria-hidden
      title={name}
      data-current={current ? "true" : undefined}
      className={cn("k-workspace-mark", className)}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.44)) }}
    >
      {monogram(name)}
    </span>
  );
}
