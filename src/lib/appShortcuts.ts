/**
 * Global keydown policy that App's capture handler applies before any
 * window-management action. Kept free of React so the rules can be tested
 * without rendering the shell.
 *
 * Two hazards this exists to stop:
 *  - Holding Ctrl+W (or any bound close/split/jump chord) would auto-repeat
 *    and drain panes under a dialog.
 *  - WebView2 treats F5 / Ctrl+R / zoom as browser chrome and would reload
 *    the webview, killing every agent. Native accelerator keys are disabled
 *    separately on Windows; this is the JS layer, including macOS/Linux.
 */

import { matchShortcut, type Chord } from "./keymap.ts";

/** Enough of a keydown to recognise browser reload/zoom and app chords. */
export type ShortcutEvent = Chord & { repeat?: boolean };

export interface ShortcutGuard {
  modalOpen: boolean;
  /** Overrides `event.repeat` when the caller already read it. */
  repeat?: boolean;
}

/**
 * Window-management actions that must not run while a modal is open.
 * Find in files (and other non-destructive view chords) are not in this set.
 */
export const WINDOW_MANAGEMENT_ACTIONS = new Set<string>([
  "closePane",
  "splitRight",
  "splitDown",
  "movePane",
  "newDeck",
  "jumpDeck",
  "nextPane",
  "prevPane",
  "goTo",
  "nextWaiting",
  "addTerminals",
  "fullscreen",
  "balance",
  "overview",
]);

export function isWindowManagementAction(action: string): boolean {
  return WINDOW_MANAGEMENT_ACTIONS.has(action);
}

/**
 * F5 / Ctrl+F5 / Ctrl+R / Ctrl+Shift+R reload, and Ctrl+plus/minus/0 zoom,
 * whether or not they match an app shortcut. Cmd is treated like Ctrl so the
 * same intercept covers macOS WebKit.
 */
export function isBrowserChromeKey(event: {
  code: string;
  ctrlKey: boolean;
  metaKey?: boolean;
}): boolean {
  if (event.code === "F5") return true;
  if (!(event.ctrlKey || event.metaKey)) return false;
  return (
    event.code === "KeyR" ||
    event.code === "Equal" ||
    event.code === "Minus" ||
    event.code === "Digit0"
  );
}

/** True when a Radix dialog (or anything else with the same markers) is open. */
export function radixDialogOpen(root: {
  querySelector: (selectors: string) => unknown;
}): boolean {
  return root.querySelector('[role="dialog"][data-state="open"]') != null;
}

/** Store flags and overlays that are not always a `[role=dialog]`. */
export function isAppModalOpen(flags: {
  radixDialog?: boolean;
  agentSettings?: boolean;
  vpnDialog?: boolean;
  launcher?: boolean;
  switcher?: boolean;
  restoreFailed?: boolean;
  shortcuts?: boolean;
}): boolean {
  return Boolean(
    flags.radixDialog ||
      flags.agentSettings ||
      flags.vpnDialog ||
      flags.launcher ||
      flags.switcher ||
      flags.restoreFailed ||
      flags.shortcuts,
  );
}

/**
 * Skip the rest of the app shortcut handler: auto-repeat, or a destructive
 * window-management chord while a modal is up. Find in files still matches.
 */
export function shouldIgnoreAppShortcut(
  event: ShortcutEvent,
  options: ShortcutGuard,
): boolean {
  if (options.repeat ?? event.repeat) return true;
  if (!options.modalOpen) return false;
  const matched = matchShortcut(event);
  return matched !== null && isWindowManagementAction(matched.action);
}
