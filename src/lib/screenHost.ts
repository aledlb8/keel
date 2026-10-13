/**
 * The main window's half of screens: windows coming back, moving, and the
 * monitors under them changing.
 *
 *  - **On launch**, the windows go back where they were on this set of
 *    monitors. A set never seen before keeps the screens that still land on a
 *    monitor that is here; the rest fold back into the main window.
 *  - **While running**, where every window is on the current set of monitors
 *    is kept up to date, as that set's arrangement.
 *  - **When the monitors change** — a laptop docked or undocked, a monitor
 *    switched off — the arrangement saved for the new set is put back, or, for
 *    a set never seen, screens left on a monitor that is gone fold back.
 *
 * The arrangement is only saved after checking the monitors are still the
 * ones it is filed under: unplugging one makes Windows shove its windows
 * across before Keel has noticed, and those places must not overwrite the
 * arrangement the windows had while it was plugged in.
 */

import {
  MAIN_WINDOW,
  boundsVisible,
  displayFingerprint,
  rememberArrangement,
  screenIdOf,
} from "./screens.ts";
import type { Arrangement, Display, WindowBounds } from "./types.ts";
import {
  displays,
  onScreenClosed,
  onWindowBounds,
  placeWindow,
} from "./windows.ts";
import { useKeel } from "../state/store.ts";

/** How often to look for monitors coming and going. */
const DISPLAY_POLL_MS = 3_000;
/** How long windows must sit still before their places are saved. */
const SETTLE_MS = 1_000;
/** Moves arrive per frame while dragging; the store hears at most this often. */
const BOUNDS_MS = 250;

/** Returns the teardown. Call once, in the main window, after `init`. */
export function startScreenHost(): () => void {
  let fingerprint: string | null = null;
  let stopped = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const current = (): Arrangement => {
    const state = useKeel.getState();
    return { main: state.mainBounds, screens: state.screens };
  };

  /** Put the windows back as `arrangement` has them, as far as it can. */
  const apply = (arrangement: Arrangement, monitors: Display[]) => {
    const keel = useKeel.getState();
    keel.arrangeScreens({
      main: arrangement.main,
      screens: arrangement.screens.filter(
        (screen) => !screen.bounds || boundsVisible(monitors, screen.bounds),
      ),
    });
    if (arrangement.main && boundsVisible(monitors, arrangement.main)) {
      void placeWindow(MAIN_WINDOW, { bounds: arrangement.main }).catch(() => {});
    }
  };

  /** The monitors are a set not seen before: keep what still has a monitor. */
  const fold = (monitors: Display[]) => {
    const keel = useKeel.getState();
    for (const screen of keel.screens) {
      if (screen.bounds && !boundsVisible(monitors, screen.bounds)) keel.closeScreen(screen.id);
    }
  };

  const monitorsChanged = (monitors: Display[], next: string) => {
    fingerprint = next;
    const saved = useKeel.getState().arrangements[next];
    if (saved) apply(saved, monitors);
    else fold(monitors);
  };

  const check = async () => {
    const monitors = await displays().catch(() => null);
    if (!monitors || monitors.length === 0 || stopped) return null;
    const next = displayFingerprint(monitors);
    if (next !== fingerprint) monitorsChanged(monitors, next);
    return monitors;
  };

  const save = async () => {
    saveTimer = undefined;
    const before = fingerprint;
    await check();
    // The monitors changed under the windows; this is not their arrangement.
    if (stopped || fingerprint === null || fingerprint !== before) return;
    const keel = useKeel.getState();
    keel.rememberArrangements(rememberArrangement(keel.arrangements, fingerprint, current()));
  };
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), SETTLE_MS);
  };

  // Launch: the last arrangement for these monitors, or what still fits.
  void (async () => {
    const monitors = await displays().catch(() => null);
    if (!monitors || monitors.length === 0 || stopped) return;
    fingerprint = displayFingerprint(monitors);
    const keel = useKeel.getState();
    const saved = keel.arrangements[fingerprint];
    apply(saved ?? current(), monitors);
  })();

  // Keep this set's arrangement current as screens open, close and move.
  let last = current();
  const unsubscribe = useKeel.subscribe((state) => {
    if (state.screens === last.screens && state.mainBounds === last.main) return;
    last = { main: state.mainBounds, screens: state.screens };
    saveSoon();
  });

  const pending = new Map<string, WindowBounds>();
  let boundsTimer: ReturnType<typeof setTimeout> | undefined;
  const flushBounds = () => {
    boundsTimer = undefined;
    const keel = useKeel.getState();
    for (const [label, bounds] of pending) keel.noteWindowBounds(label, bounds);
    pending.clear();
  };
  const stopBounds = onWindowBounds((label, bounds) => {
    pending.set(label, bounds);
    boundsTimer ??= setTimeout(flushBounds, BOUNDS_MS);
  });
  const stopClosed = onScreenClosed((label) => {
    const screenId = screenIdOf(label);
    if (screenId) useKeel.getState().noteScreenClosed(screenId);
  });

  const poll = setInterval(() => void check(), DISPLAY_POLL_MS);

  return () => {
    stopped = true;
    unsubscribe();
    clearInterval(poll);
    clearTimeout(saveTimer);
    clearTimeout(boundsTimer);
    void stopBounds.then((stop) => stop());
    void stopClosed.then((stop) => stop());
  };
}
