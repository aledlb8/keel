/**
 * A green 5px mark that a file (or folder) changed in the last few minutes.
 *
 * Git already paints an amber dot on dirty folders. This one is green so the two
 * can sit on the same row without being the same signal.
 */

export function RecentDot({ at, now }: { at: number; now?: number }) {
  const age = (now ?? Date.now()) - at;
  const minutes = Math.max(0, Math.floor(age / 60_000));
  const title =
    minutes < 1 ? "Changed just now" : `Changed ${minutes} min ago`;
  return (
    <span
      aria-hidden
      title={title}
      className="size-[5px] rounded-full bg-[color:var(--keel-done)]"
    />
  );
}
