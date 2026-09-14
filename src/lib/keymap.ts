/**
 * Every keyboard shortcut in the app, in one place.
 *
 * Two things here are load-bearing:
 *
 *  1. **Capture phase.** xterm calls `stopPropagation()` on any chord it decides
 *     to turn into an escape sequence, so a normal bubble-phase listener on
 *     `window` never sees Alt+Shift+Arrow. Capture runs before the terminal's own
 *     handler, so we get first refusal and can stop the key reaching the agent.
 *
 *  2. **`event.code`, not `event.key`.** `code` is the physical key, unaffected by
 *     modifiers or keyboard layout. With `key`, Alt+Shift+W is "W" on one layout
 *     and something else entirely on another.
 */

import type { MoveDirection } from "./tree";

export interface Shortcut {
  /** Physical key, as `KeyboardEvent.code`. */
  code: string;
  /** How it reads in the shortcuts sheet. */
  keys: string;
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  { code: "ArrowLeft", keys: "Alt+Shift+←", label: "Move pane left" },
  { code: "ArrowRight", keys: "Alt+Shift+→", label: "Move pane right" },
  { code: "ArrowUp", keys: "Alt+Shift+↑", label: "Move pane up" },
  { code: "ArrowDown", keys: "Alt+Shift+↓", label: "Move pane down" },
  { code: "KeyF", keys: "Alt+Shift+F", label: "Fullscreen the focused pane" },
  { code: "KeyD", keys: "Alt+Shift+D", label: "Split right" },
  { code: "KeyS", keys: "Alt+Shift+S", label: "Split down" },
  { code: "KeyW", keys: "Alt+Shift+W", label: "Close the focused pane" },
  { code: "KeyE", keys: "Alt+Shift+E", label: "Even out every split" },
  { code: "Tab", keys: "Alt+Shift+Tab", label: "Focus the next pane" },
  { code: "KeyT", keys: "Alt+Shift+T", label: "Add terminals" },
  { code: "Space", keys: "Alt+Shift+Space", label: "Overview of every deck" },
  { code: "Enter", keys: "Alt+Shift+Enter", label: "New deck" },
  { code: "Digit1", keys: "Alt+Shift+1…9", label: "Jump to a deck" },
];

/** `Digit1`…`Digit9` map to deck 1-9. Anything past nine is rail or overview. */
export function deckIndexOf(code: string): number | null {
  const match = /^Digit([1-9])$/.exec(code);
  return match ? Number(match[1]) - 1 : null;
}

export const MOVES: Record<string, MoveDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** True when the event is one of ours: Alt+Shift and nothing else held. */
export function isKeelChord(event: KeyboardEvent): boolean {
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey;
}
