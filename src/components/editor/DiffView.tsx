/**
 * One git change, read the way a code review reads it.
 *
 * The code keeps its own colour; only the ground under a line says what
 * happened to it, with the sign and the line numbers carrying a stronger tint
 * of the same hue. Colouring the text itself green and red made a large diff
 * hard to read and turned every addition into a highlight. Hunk headers stick
 * to the top while you scroll through them, with the enclosing function git
 * named beside the line range.
 */

import { FileDiff } from "lucide-react";

import { DockNotice } from "@/components/Dock";
import { splitHunkHeader } from "@/lib/git";
import { useWorkspace } from "@/state/workspace";

export function DiffView({ id }: { id: string }) {
  const diff = useWorkspace((state) => state.diffs[id]);

  if (diff?.binary) {
    return (
      <DockNotice
        icon={FileDiff}
        title="Binary file"
        detail="Git can't show a line-by-line diff for this file."
        className="h-full justify-center"
      />
    );
  }

  if (!diff || diff.hunks.length === 0) {
    return (
      <DockNotice
        icon={FileDiff}
        title="No changes"
        detail="Nothing here differs any more."
        className="h-full justify-center"
      />
    );
  }

  return (
    <div className="k-diff h-full min-h-0 overflow-auto">
      {/* Wide enough for the longest line, so tints run the full width. */}
      <div className="inline-block min-w-full pb-4">
        {diff.hunks.map((hunk, index) => {
          const { range, context } = splitHunkHeader(hunk.header);
          return (
            <section key={`${hunk.header}:${index}`}>
              <div className="k-diff-hunk">
                <span className="shrink-0">{range}</span>
                {context ? (
                  <span className="min-w-0 truncate text-dim">{context}</span>
                ) : null}
              </div>
              {hunk.lines.map((line, lineIndex) => (
                <div key={lineIndex} data-kind={line.kind} className="k-diff-line">
                  <span className="k-diff-no">{line.oldNo ?? ""}</span>
                  <span className="k-diff-no">{line.newNo ?? ""}</span>
                  <span className="k-diff-sign">
                    {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
                  </span>
                  <span className="k-diff-text">{line.text || " "}</span>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
