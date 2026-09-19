/**
 * A name, edited where it is shown.
 *
 * Enter or clicking away keeps the new name; Escape puts the old one back. An
 * empty name is never saved. Focus is taken a frame late so it lands after
 * whatever opened the field — a context menu closing, a double-click — has
 * finished moving focus around.
 */

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export function InlineRename({
  value,
  onCommit,
  onDone,
  className,
}: {
  value: string;
  onCommit: (name: string) => void;
  onDone: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(value);
  const finished = useRef(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const finish = (keep: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const clean = draft.trim();
    if (keep && clean && clean !== value) onCommit(clean);
    onDone();
  };

  return (
    <input
      ref={ref}
      value={draft}
      aria-label="Name"
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") finish(false);
      }}
      // The row underneath navigates on click; typing in here must not.
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn(
        "h-6 min-w-0 flex-1 rounded-[var(--keel-r-chip)] border border-foreground/25 bg-veil-2 px-1.5 text-row text-foreground outline-none selection:bg-foreground/20",
        className,
      )}
    />
  );
}
