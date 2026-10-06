/**
 * Window focus, published on the document as `data-window-inactive`.
 *
 * The window is transparent, so a Keel left in the background fades and lets
 * the desktop through. The fade hangs off this one attribute in CSS rather
 * than React state: nothing re-renders, no terminal is touched, it is just a
 * composited opacity on the shell.
 *
 * The fade waits `AWAY_DELAY_MS` after focus leaves, so a quick glance at
 * another window does not flicker the shell — only actually being away does.
 * Coming back clears it at once.
 *
 * `document.hasFocus()` is deliberately the source of truth. It is the same
 * reading the chime and the OS toasts use to decide whether you are watching,
 * so the whole app agrees on what "in the background" means.
 */

/** How long the window must stay unfocused before it fades. */
export const AWAY_DELAY_MS = 30_000;

/** Returns the listener's teardown. The fade itself lives in `index.css`. */
export function startWindowFocusTracking(): () => void {
  const root = document.documentElement;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    clearTimeout(pending);
    pending = undefined;
  };
  const sync = () => {
    if (document.hasFocus()) {
      cancel();
      delete root.dataset.windowInactive;
    } else if (pending === undefined && !root.dataset.windowInactive) {
      pending = setTimeout(() => {
        pending = undefined;
        if (!document.hasFocus()) root.dataset.windowInactive = "true";
      }, AWAY_DELAY_MS);
    }
  };

  sync();
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);

  return () => {
    window.removeEventListener("focus", sync);
    window.removeEventListener("blur", sync);
    cancel();
    delete root.dataset.windowInactive;
  };
}
