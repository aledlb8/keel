/**
 * How often terminals you are not using repaint.
 *
 * xterm repaints on the next animation frame after every write, so an agent's
 * spinner on a 144 Hz screen can cost a WebGL draw and a composite of the whole
 * window many times a second, per pane. Only the terminal you are typing in or
 * pointing at needs that. Every other terminal on screen still takes its output
 * as it comes, but repaints on a shared beat: their repaints are gathered and
 * let through together, a few times a second, so a deck of busy agents costs
 * one window update per beat rather than one per pane per write.
 *
 * Nothing runs between beats: the beat is only scheduled while something is
 * waiting to be painted.
 */

/** Repaints a second for terminals you are not using. */
export const BACKGROUND_FPS = 15;

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The beat that background repaints wait for. */
export interface PaintBeat {
  /** Run `paint` on the next beat. Asking again before then changes nothing. */
  wait(paint: () => void): void;
  /** No longer run `paint` on the next beat. */
  drop(paint: () => void): void;
}

export function createPaintBeat(
  frameMs = 1000 / BACKGROUND_FPS,
  timers: Timers = realTimers,
): PaintBeat {
  const waiting = new Set<() => void>();
  let handle: unknown;
  let scheduled = false;

  const beat = () => {
    scheduled = false;
    const due = [...waiting];
    waiting.clear();
    for (const paint of due) paint();
  };

  return {
    wait(paint) {
      waiting.add(paint);
      if (scheduled) return;
      scheduled = true;
      handle = timers.set(beat, frameMs);
    },
    drop(paint) {
      waiting.delete(paint);
      if (waiting.size > 0 || !scheduled) return;
      scheduled = false;
      timers.clear(handle);
    },
  };
}

/** The part of xterm's render debouncer this needs. */
export interface RowRefresher {
  refresh(rowStart: number | undefined, rowEnd: number | undefined, rowCount: number): void;
}

export interface PacedPainting {
  /** In use: paint on the next frame. Not in use: paint on the beat. */
  setUsed(used: boolean): void;
  /**
   * Paint what is waiting on the next frame, beat or not. For when the canvas
   * was just blanked — a resize, a new renderer — and waiting would show it.
   */
  flush(): void;
  /** Drop anything still waiting. Call before the terminal is disposed. */
  dispose(): void;
}

/**
 * Put a terminal's repaints on `beat` while it is not in use.
 *
 * Rows asked for between beats are merged into one range, so nothing that
 * changed is skipped — it is only painted a little later. Becoming used paints
 * whatever is waiting straight away.
 */
export function pacePainting(
  refresher: RowRefresher,
  beat: PaintBeat,
  used = false,
): PacedPainting {
  const refresh = refresher.refresh.bind(refresher);
  let start: number | undefined;
  let end: number | undefined;
  let count = 0;
  let pending = false;
  let disposed = false;

  const paint = () => {
    pending = false;
    if (disposed) return;
    const rowStart = start;
    const rowEnd = end;
    start = undefined;
    end = undefined;
    refresh(rowStart, rowEnd, count);
  };

  refresher.refresh = (rowStart, rowEnd, rowCount) => {
    if (used && !pending) {
      refresh(rowStart, rowEnd, rowCount);
      return;
    }
    count = rowCount;
    const from = rowStart ?? 0;
    const to = rowEnd ?? rowCount - 1;
    start = start === undefined ? from : Math.min(start, from);
    end = end === undefined ? to : Math.max(end, to);
    if (pending) return;
    pending = true;
    beat.wait(paint);
  };

  const flush = () => {
    if (!pending) return;
    beat.drop(paint);
    paint();
  };

  return {
    setUsed(next) {
      used = next;
      if (used) flush();
    },
    flush,
    dispose() {
      disposed = true;
      if (pending) beat.drop(paint);
      pending = false;
    },
  };
}

/** The beat every terminal in this window shares. */
export const backgroundBeat = createPaintBeat();
