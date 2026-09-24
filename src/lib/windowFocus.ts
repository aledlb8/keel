/**
 * Window focus, published on the document as `data-window-inactive`.
 *
 * The window is transparent, so an unfocused Keel fades and lets the desktop
 * through. The fade hangs off this one attribute in CSS rather than React
 * state: nothing re-renders, no terminal is touched, it is just a composited
 * opacity on the shell.
 *
 * `document.hasFocus()` is deliberately the source of truth. It is the same
 * reading the chime and the OS toasts use to decide whether you are watching,
 * so the whole app agrees on what "in the background" means.
 */

/** Returns the listener's teardown. The fade itself lives in `index.css`. */
export function startWindowFocusTracking(): () => void {
  const root = document.documentElement;
  const sync = () => {
    if (document.hasFocus()) delete root.dataset.windowInactive;
    else root.dataset.windowInactive = "true";
  };

  sync();
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);

  return () => {
    window.removeEventListener("focus", sync);
    window.removeEventListener("blur", sync);
    delete root.dataset.windowInactive;
  };
}
