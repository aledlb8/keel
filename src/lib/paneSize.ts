/**
 * How big a pane's terminal would be, from the box the layout gives it.
 *
 * A process is started before any window draws it, so it needs a size before
 * an xterm can say. The canvas measures every deck's boxes whether or not they
 * are on screen; this turns a box into columns and rows with the terminal
 * font's cell, near enough that an agent started on a hidden deck draws at
 * almost its real width. The first window to draw it resizes it exactly.
 */

/** The pane's header and the terminal's inset, which the grid does not get. */
const HEADER = 30;
const INSET = 20;
const FONT_SIZE = 15;

const hints = new Map<string, { cols: number; rows: number }>();
let cell: { width: number; height: number } | null = null;

function cellSize(): { width: number; height: number } {
  if (cell) return cell;
  const fallback = { width: FONT_SIZE * 0.6, height: FONT_SIZE * 1.2 };
  if (typeof document === "undefined") return fallback;
  const context = document.createElement("canvas").getContext("2d");
  const family = getComputedStyle(document.documentElement)
    .getPropertyValue("--keel-font-term")
    .trim();
  if (!context || !family) return fallback;
  context.font = `${FONT_SIZE}px ${family}`;
  const metrics = context.measureText("W");
  const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  cell = {
    width: metrics.width || fallback.width,
    height: Number.isFinite(height) && height > 0 ? Math.ceil(height) : fallback.height,
  };
  return cell;
}

export function notePaneBox(paneId: string, width: number, height: number): void {
  if (width <= 0 || height <= 0) return;
  const { width: cellWidth, height: cellHeight } = cellSize();
  hints.set(paneId, {
    cols: Math.max(20, Math.floor((width - INSET) / cellWidth)),
    rows: Math.max(5, Math.floor((height - HEADER - INSET) / cellHeight)),
  });
}

/** Columns and rows for a pane about to start, or a sensible default. */
export function paneSizeHint(paneId: string): { cols: number; rows: number } {
  return hints.get(paneId) ?? { cols: 100, rows: 30 };
}
