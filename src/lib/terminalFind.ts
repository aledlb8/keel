/**
 * Find chords for one terminal, never registered as a global shortcut.
 *
 * Ctrl+F in the editor is CodeMirror's. These only fire from a pane's xterm
 * helper textarea or that pane's search bar, so they cannot steal from it.
 */

export type TerminalFindAction = "open" | "next" | "previous";

/** Enough of a keydown to recognise Ctrl+F / Ctrl+G / F3 / Shift+F3. */
export interface FindChord {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Which find action this keydown is, if any. Enter / Shift+Enter / Escape are
 * handled on the search bar, not here — Enter in the terminal is a real key.
 */
export function isTerminalFindChord(event: FindChord): TerminalFindAction | null {
  if (event.altKey || event.metaKey) return null;
  if (event.ctrlKey && !event.shiftKey && event.code === "KeyF") return "open";
  if (event.ctrlKey && !event.shiftKey && event.code === "KeyG") return "next";
  if (!event.ctrlKey && event.code === "F3") {
    return event.shiftKey ? "previous" : "next";
  }
  return null;
}

/**
 * SearchAddon decorations must be #RRGGBB. Muted yellow on the dark terminal,
 * brighter for the active match; overview-ruler colours are required fields.
 */
export const TERMINAL_SEARCH_DECORATIONS = {
  matchBackground: "#6b5a2a",
  activeMatchBackground: "#e9a23b",
  matchOverviewRuler: "#6b5a2a",
  activeMatchColorOverviewRuler: "#e9a23b",
} as const;
