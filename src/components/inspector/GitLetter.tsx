/**
 * Git's one-letter verdict on a file, on a small chip tinted with its own hue.
 *
 * The letter alone was hard to find at 11px, and colouring the file name
 * instead lit the whole list up. A 16px chip is findable without shouting.
 */

import { gitLetter, gitLetterColor, gitStatusLabel } from "@/lib/git";
import { cn } from "@/lib/utils";
import type { GitFileStatus } from "@/lib/workspace";

export function GitLetter({
  status,
  className,
}: {
  status: GitFileStatus;
  className?: string;
}) {
  return (
    <span
      title={gitStatusLabel(status)}
      aria-label={gitStatusLabel(status)}
      className={cn("k-git-letter", className)}
      style={{ ["--git" as string]: gitLetterColor(status) }}
    >
      {gitLetter(status)}
    </span>
  );
}
