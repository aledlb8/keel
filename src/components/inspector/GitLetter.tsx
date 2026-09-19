/**
 * Git's one-letter verdict on a file, on a small chip tinted with its own hue.
 *
 * The letter alone was hard to find at 11px, so it sits on a 16px chip. The
 * file's name carries the same hue beside it, the way an IDE's explorer does.
 */

import { gitLetter, gitStatusColor, gitStatusLabel } from "@/lib/git";
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
      style={{ ["--git" as string]: gitStatusColor(status) }}
    >
      {gitLetter(status)}
    </span>
  );
}
