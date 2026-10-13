/**
 * Decks in windows of their own, and the monitors those windows sit on.
 *
 * Pure rules over plain data, so they can be tested without a window. The store
 * keeps the list of screens; `src/lib/windows.ts` opens and places the windows.
 *
 * A deck is on at most one screen. A deck on no screen belongs to the main
 * window, which shows one of those — never one a screen has.
 */

import type {
  Arrangement,
  Deck,
  Display,
  Project,
  Screen,
  WindowBounds,
} from "./types.ts";
import type { MoveDirection } from "./tree.ts";

export const MAIN_WINDOW = "main";
export const SCREEN_PREFIX = "screen-";
/** Every agent in Keel, in a small window of its own. */
export const BOARD_WINDOW = "board";

/** How many sets of monitors to remember arrangements for. */
const ARRANGEMENTS_KEPT = 8;

export function screenLabel(screenId: string): string {
  return `${SCREEN_PREFIX}${screenId}`;
}

/** The screen id in a window label, or null for the main window. */
export function screenIdOf(label: string): string | null {
  return label.startsWith(SCREEN_PREFIX) ? label.slice(SCREEN_PREFIX.length) : null;
}

export function screenOfDeck(screens: readonly Screen[], deckId: string): Screen | null {
  return screens.find((screen) => screen.deckId === deckId) ?? null;
}

export function screenOfPane(
  screens: readonly Screen[],
  projects: readonly Project[],
  paneId: string,
): Screen | null {
  for (const project of projects) {
    const deck = project.decks.find((item) => paneId in item.panes);
    if (deck) return screenOfDeck(screens, deck.id);
  }
  return null;
}

/** Which window draws a deck: a screen's label, or the main window's. */
export function windowOfDeck(screens: readonly Screen[], deckId: string): string {
  const screen = screenOfDeck(screens, deckId);
  return screen ? screenLabel(screen.id) : MAIN_WINDOW;
}

/**
 * The deck the main window shows for a project: its active deck, unless a
 * screen has that one, in which case the first that no screen has. `null`
 * when every deck of the project is on a screen.
 */
export function mainDeckOf(
  project: Project | null | undefined,
  screens: readonly Screen[],
): Deck | null {
  if (!project) return null;
  const away = new Set(screens.map((screen) => screen.deckId));
  const active = project.decks.find((deck) => deck.id === project.activeDeckId);
  if (active && !away.has(active.id)) return active;
  return project.decks.find((deck) => !away.has(deck.id)) ?? null;
}

/**
 * The deck the main window should show once `leaving` goes to a screen: the
 * active one if that stays, otherwise the nearest that is not on a screen.
 * `null` when none is left.
 */
export function deckAfterLeaving(
  project: Project,
  screens: readonly Screen[],
  leaving: string,
): string | null {
  const away = new Set([...screens.map((screen) => screen.deckId), leaving]);
  if (project.activeDeckId && !away.has(project.activeDeckId)) return project.activeDeckId;
  const index = Math.max(0, project.decks.findIndex((deck) => deck.id === leaving));
  const after = project.decks.slice(index + 1).find((deck) => !away.has(deck.id));
  const before = project.decks.slice(0, index).reverse().find((deck) => !away.has(deck.id));
  return (after ?? before)?.id ?? null;
}

// ---- Monitors --------------------------------------------------------------

/**
 * One string for a set of monitors: their sizes and where they sit. Names are
 * left out because Windows renumbers them; a docked laptop gets the same
 * fingerprint every time it is docked.
 */
export function displayFingerprint(displays: readonly Display[]): string {
  return [...displays]
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((display) => `${display.width}x${display.height}@${display.x},${display.y}`)
    .join("|");
}

function centre(bounds: { x: number; y: number; width: number; height: number }) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/** The monitor a window's middle is on. */
export function displayAt(
  displays: readonly Display[],
  bounds: WindowBounds,
): Display | null {
  const middle = centre(bounds);
  return (
    displays.find(
      (display) =>
        middle.x >= display.x &&
        middle.x < display.x + display.width &&
        middle.y >= display.y &&
        middle.y < display.y + display.height,
    ) ?? null
  );
}

/** Still on a monitor that is attached. */
export function boundsVisible(
  displays: readonly Display[],
  bounds: WindowBounds | undefined,
): boolean {
  return bounds !== undefined && displayAt(displays, bounds) !== null;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Of `items`, the one next to `from` in `direction`: its middle lies that
 * way, and of those the one whose middle is nearest — straight across
 * beating diagonal. Works the same for monitors and for windows.
 */
export function nearestToward<T extends Rect>(
  items: readonly T[],
  from: Rect,
  direction: MoveDirection,
): T | null {
  const origin = centre(from);
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const point = centre(item);
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const along =
      direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;
    const across = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0) continue;
    const score = along + across * 2;
    if (!best || score < best.score) best = { item, score };
  }
  return best?.item ?? null;
}

/** The monitor next to `from` in `direction`. */
export function displayToward(
  displays: readonly Display[],
  from: Display,
  direction: MoveDirection,
): Display | null {
  return nearestToward(
    displays.filter((display) => display.x !== from.x || display.y !== from.y),
    from,
    direction,
  );
}

/** Two monitors are the same one: they sit in the same place. */
export function sameDisplay(a: Display | null, b: Display | null): boolean {
  return a !== null && b !== null && a.x === b.x && a.y === b.y;
}

/** Monitors left to right, then top to bottom: the order "next screen" walks. */
export function displaysInOrder(displays: readonly Display[]): Display[] {
  return [...displays].sort((a, b) => a.x - b.x || a.y - b.y);
}

// ---- Saved data ------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function readBounds(raw: unknown): WindowBounds | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as Record<string, unknown>;
  if (
    !isFiniteNumber(entry.x) ||
    !isFiniteNumber(entry.y) ||
    !isFiniteNumber(entry.width) ||
    !isFiniteNumber(entry.height) ||
    entry.width <= 0 ||
    entry.height <= 0
  ) {
    return undefined;
  }
  return {
    x: Math.round(entry.x),
    y: Math.round(entry.y),
    width: Math.round(entry.width),
    height: Math.round(entry.height),
    maximized: entry.maximized === true,
    monitor: typeof entry.monitor === "string" ? entry.monitor : null,
  };
}

const SCREEN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function readBoard(raw: unknown): { bounds?: WindowBounds; onTop?: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const bounds = readBounds(entry.bounds);
  return {
    ...(bounds ? { bounds } : {}),
    ...(entry.onTop === true ? { onTop: true } : {}),
  };
}

/** Saved screens whose deck still exists, each deck on one screen at most. */
export function readScreens(raw: unknown, projects: readonly Project[]): Screen[] {
  if (!Array.isArray(raw)) return [];
  const screens: Screen[] = [];
  const ids = new Set<string>();
  const decks = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const { id, projectId, deckId } = entry;
    if (typeof id !== "string" || !SCREEN_ID.test(id) || ids.has(id)) continue;
    if (typeof projectId !== "string" || typeof deckId !== "string") continue;
    if (decks.has(deckId)) continue;
    const project = projects.find((item) => item.id === projectId);
    if (!project?.decks.some((deck) => deck.id === deckId)) continue;
    ids.add(id);
    decks.add(deckId);
    screens.push({
      id,
      projectId,
      deckId,
      bounds: readBounds(entry.bounds),
      ...(entry.onTop === true ? { onTop: true } : {}),
      ...(typeof entry.returnTo === "string" ? { returnTo: entry.returnTo } : {}),
    });
  }
  return screens;
}

export function readArrangements(
  raw: unknown,
  projects: readonly Project[],
): Record<string, Arrangement> {
  if (!raw || typeof raw !== "object") return {};
  const arrangements: Record<string, Arrangement> = {};
  for (const [fingerprint, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    arrangements[fingerprint] = {
      main: readBounds(entry.main),
      screens: readScreens(entry.screens, projects),
    };
  }
  return arrangements;
}

/** Keep `arrangement` for `fingerprint`, most recent last, dropping the oldest. */
export function rememberArrangement(
  arrangements: Record<string, Arrangement>,
  fingerprint: string,
  arrangement: Arrangement,
): Record<string, Arrangement> {
  const rest = Object.entries(arrangements).filter(([key]) => key !== fingerprint);
  const kept = rest.slice(Math.max(0, rest.length - (ARRANGEMENTS_KEPT - 1)));
  return Object.fromEntries([...kept, [fingerprint, arrangement]]);
}
