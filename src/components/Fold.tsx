/**
 * Height that opens and closes on its own: a folder's children in the file
 * tree, a project's terminals in the dock, a section of the git panel.
 *
 * The rows go in a grid whose single track runs from `0fr` to `1fr`, so the
 * height animates without anyone measuring it and whatever is inside can be
 * any height at all — including content that arrives a moment later, which
 * simply carries on growing rather than popping.
 *
 * Children exist only while the fold is open or still closing, so a closed
 * folder costs nothing and a closing one is never left behind. Nothing
 * animates on the first paint: a tree restored with folders already open
 * should just be open.
 */

import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Matches the `.k-fold` transitions. */
const OPEN_MS = 200;
const CLOSE_MS = 160;

export function Fold({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  // `shown` lags `mounted` by a frame, so the track has a zero to grow from.
  const [shown, setShown] = useState(open);
  // Open and done moving: the clipping can go, so drop lines and rings show.
  const [settled, setSettled] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open || !mounted || shown) return;
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [open, mounted, shown]);

  useEffect(() => {
    if (!shown) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), OPEN_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);

  if (!mounted) return null;

  return (
    <div
      className={cn("k-fold", className)}
      data-open={shown ? "true" : undefined}
      data-settled={settled ? "true" : undefined}
    >
      <div className="k-fold-body">{children}</div>
    </div>
  );
}
