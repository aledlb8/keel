/**
 * Every keyboard shortcut in the app, in one place.
 *
 * Two things here are load-bearing:
 *
 *  1. **Capture phase.** xterm calls `stopPropagation()` on any chord it decides
 *     to turn into an escape sequence, so a normal bubble-phase listener on
 *     `window` never sees it. Capture runs before the terminal's own handler,
 *     so we get first refusal and can stop the key reaching the agent.
 *
 *  2. **`event.code`, not `event.key`.** `code` is the physical key, unaffected by
 *     modifiers or keyboard layout. With `key`, Ctrl+Shift+W is "W" on one layout
 *     and something else entirely on another.
 *
 * The default chords follow the browser / Windows Terminal vocabulary people
 * already have in their fingers: Ctrl+T to add, Ctrl+W to close, Ctrl+1…9 to
 * jump. Shift is only added when a bare Ctrl chord would steal a key the
 * terminal actually uses (Ctrl+D is EOF, Ctrl+S is XOFF, Ctrl+E is end-of-line).
 * Alt+Shift is never used — on Windows it is the default keyboard-layout switch.
 *
 * **Defaults live here; your changes do not.** What you customise is saved as
 * overrides — a different chord, or none at all — and `setKeybindingOverrides`
 * folds them over the defaults into the active set everything else reads.
 * Resetting a shortcut drops its override, so a default improved in a later
 * release still reaches every shortcut you never touched.
 *
 * Two actions are families rather than single chords: jump to deck 1…9 and move
 * the pane with the arrows. For those you choose the modifiers; the keys stay
 * the numbers and the arrows.
 */

import type { MoveDirection } from "./tree";

export type ShortcutId =
  | "goTo"
  | "nextWaiting"
  | "nextPane"
  | "prevPane"
  | "jumpDeck"
  | "addTerminals"
  | "closePane"
  | "splitRight"
  | "splitDown"
  | "fullscreen"
  | "balance"
  | "movePane"
  | "newDeck"
  | "overview"
  | "toggleSidebar"
  | "toggleInspector"
  | "menuBar"
  | "rename";

export type ShortcutGroup = "Jump" | "Panes" | "Decks" | "View";

/** How much of the chord is yours to choose: all of it, or only the modifiers. */
export type ShortcutFamily = "single" | "digits" | "arrows";

/** A chord. For a family, `code` is a representative key (Digit1, ArrowLeft). */
export interface Binding {
  /** Physical key, as `KeyboardEvent.code`. */
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export interface Shortcut {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  family: ShortcutFamily;
  defaults: Binding;
}

/** What you changed: a chord in place of the default, or null for none. */
export type KeybindingOverrides = Partial<Record<ShortcutId, Binding | null>>;

/** The chord each action answers to right now. */
export type Bindings = Record<ShortcutId, Binding | null>;

function bind(
  code: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): Binding {
  return {
    code,
    ctrl: Boolean(mods.ctrl),
    shift: Boolean(mods.shift),
    alt: Boolean(mods.alt),
  };
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  "Jump",
  "Panes",
  "Decks",
  "View",
];

export const SHORTCUTS: Shortcut[] = [
  {
    id: "goTo",
    label: "Go to a terminal, deck, project, workspace or action",
    group: "Jump",
    family: "single",
    defaults: bind("KeyP", { ctrl: true }),
  },
  {
    id: "nextWaiting",
    label: "Next waiting agent",
    group: "Jump",
    family: "single",
    defaults: bind("F8"),
  },
  {
    id: "nextPane",
    label: "Focus the next pane",
    group: "Jump",
    family: "single",
    defaults: bind("Tab", { ctrl: true }),
  },
  {
    id: "prevPane",
    label: "Focus the previous pane",
    group: "Jump",
    family: "single",
    defaults: bind("Tab", { ctrl: true, shift: true }),
  },
  {
    id: "jumpDeck",
    label: "Jump to a deck",
    group: "Jump",
    family: "digits",
    defaults: bind("Digit1", { ctrl: true }),
  },
  {
    id: "addTerminals",
    label: "Add terminals",
    group: "Panes",
    family: "single",
    defaults: bind("KeyT", { ctrl: true }),
  },
  {
    id: "closePane",
    label: "Close the focused pane",
    group: "Panes",
    family: "single",
    defaults: bind("KeyW", { ctrl: true }),
  },
  {
    id: "splitRight",
    label: "Split right",
    group: "Panes",
    family: "single",
    defaults: bind("KeyD", { ctrl: true, shift: true }),
  },
  {
    id: "splitDown",
    label: "Split down",
    group: "Panes",
    family: "single",
    defaults: bind("KeyS", { ctrl: true, shift: true }),
  },
  {
    id: "fullscreen",
    label: "Fullscreen the focused pane",
    group: "Panes",
    family: "single",
    defaults: bind("F11"),
  },
  {
    id: "balance",
    label: "Even out every split",
    group: "Panes",
    family: "single",
    defaults: bind("KeyE", { ctrl: true, shift: true }),
  },
  {
    id: "movePane",
    label: "Move the focused pane",
    group: "Panes",
    family: "arrows",
    defaults: bind("ArrowLeft", { ctrl: true, shift: true }),
  },
  {
    id: "newDeck",
    label: "New deck",
    group: "Decks",
    family: "single",
    defaults: bind("KeyN", { ctrl: true }),
  },
  {
    id: "overview",
    label: "Overview of every deck",
    group: "Decks",
    family: "single",
    defaults: bind("KeyO", { ctrl: true }),
  },
  {
    id: "toggleSidebar",
    label: "Collapse or expand the sidebar",
    group: "View",
    family: "single",
    defaults: bind("KeyB", { ctrl: true }),
  },
  {
    id: "toggleInspector",
    label: "Collapse or expand files and git",
    group: "View",
    family: "single",
    // A letter, not Backslash: on Spanish, German and other layouts "\" needs
    // AltGr, which Windows reports as Ctrl+Alt, so Ctrl+\ could never be typed.
    // Shift+B pairs it with Ctrl+B for the sidebar on the other side.
    defaults: bind("KeyB", { ctrl: true, shift: true }),
  },
  {
    id: "menuBar",
    label: "Open the menu bar",
    group: "View",
    family: "single",
    defaults: bind("F10"),
  },
  {
    id: "rename",
    label: "Rename",
    group: "View",
    family: "single",
    defaults: bind("F2"),
  },
];

const BY_ID = new Map(SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));

export function shortcutById(id: ShortcutId): Shortcut {
  const shortcut = BY_ID.get(id);
  if (!shortcut) throw new Error(`unknown shortcut ${id}`);
  return shortcut;
}

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

const DIGIT_CODES = Array.from({ length: 9 }, (_, index) => `Digit${index + 1}`);
const ARROW_CODES = Object.keys(MOVES);

// ---- Overrides -------------------------------------------------------------

export function sameBinding(
  a: Binding | null | undefined,
  b: Binding | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.code === b.code && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt
  );
}

export function resolveBindings(overrides: KeybindingOverrides): Bindings {
  const bindings = {} as Bindings;
  for (const shortcut of SHORTCUTS) {
    bindings[shortcut.id] =
      shortcut.id in overrides
        ? (overrides[shortcut.id] ?? null)
        : shortcut.defaults;
  }
  return bindings;
}

let active: Bindings = resolveBindings({});

/** Make these overrides the chords the whole app answers to and prints. */
export function setKeybindingOverrides(overrides: KeybindingOverrides) {
  active = resolveBindings(overrides);
}

export function activeBindings(): Bindings {
  return active;
}

export function bindingFor(id: ShortcutId): Binding | null {
  return active[id];
}

/** True when this action answers to something other than its default. */
export function isCustomized(
  id: ShortcutId,
  overrides: KeybindingOverrides,
): boolean {
  return (
    id in overrides &&
    !sameBinding(overrides[id] ?? null, shortcutById(id).defaults)
  );
}

/** Set one chord. Choosing the default again removes the override entirely. */
export function withOverride(
  overrides: KeybindingOverrides,
  id: ShortcutId,
  binding: Binding | null,
): KeybindingOverrides {
  const next = { ...overrides };
  if (sameBinding(binding, shortcutById(id).defaults)) delete next[id];
  else next[id] = binding;
  return next;
}

export function withoutOverride(
  overrides: KeybindingOverrides,
  id: ShortcutId,
): KeybindingOverrides {
  const next = { ...overrides };
  delete next[id];
  return next;
}

/** Overrides as read from disk: unknown actions and malformed chords are dropped. */
export function readKeybindingOverrides(raw: unknown): KeybindingOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const overrides: KeybindingOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const shortcut = BY_ID.get(key as ShortcutId);
    if (!shortcut) continue;
    if (value === null) {
      overrides[shortcut.id] = null;
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.code !== "string" || !entry.code) continue;
    const mods = {
      ctrl: entry.ctrl === true,
      shift: entry.shift === true,
      alt: entry.alt === true,
    };
    if (shortcut.family === "digits") {
      if (deckIndexOf(entry.code) === null) continue;
      overrides[shortcut.id] = bind("Digit1", mods);
    } else if (shortcut.family === "arrows") {
      if (!(entry.code in MOVES)) continue;
      overrides[shortcut.id] = bind("ArrowLeft", mods);
    } else {
      overrides[shortcut.id] = bind(entry.code, mods);
    }
  }
  return overrides;
}

// ---- How chords read -------------------------------------------------------

const KEY_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  Escape: "Esc",
  Backspace: "Backspace",
  Delete: "Del",
  Insert: "Ins",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num -",
  NumpadMultiply: "Num *",
  NumpadDivide: "Num /",
  NumpadDecimal: "Num .",
  NumpadEnter: "Num Enter",
  ContextMenu: "Menu",
  Pause: "Pause",
  PrintScreen: "PrtSc",
};

export function keyLabel(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return `Num ${numpad[1]}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return KEY_LABELS[code] ?? code;
}

/** The chord as separate keycaps: ["Ctrl", "Shift", "D"]. */
export function bindingParts(
  binding: Binding,
  family: ShortcutFamily = "single",
): string[] {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.shift) parts.push("Shift");
  if (binding.alt) parts.push("Alt");
  parts.push(
    family === "digits"
      ? "1…9"
      : family === "arrows"
        ? "←/→/↑/↓"
        : keyLabel(binding.code),
  );
  return parts;
}

export function formatBinding(
  binding: Binding,
  family: ShortcutFamily = "single",
): string {
  return bindingParts(binding, family).join("+");
}

/** How an action's chord reads right now, or "" when it has none. */
export function shortcutKeys(id: ShortcutId): string {
  const binding = active[id];
  return binding ? formatBinding(binding, shortcutById(id).family) : "";
}

/** "Split right (Ctrl+Shift+D)", or just the label when there is no chord. */
export function withShortcut(label: string, id: ShortcutId): string {
  const keys = shortcutKeys(id);
  return keys ? `${label} (${keys})` : label;
}

/** The chord for one particular deck, like "Ctrl+3", or "" when there is none. */
export function deckShortcutKeys(index: number): string {
  const binding = active.jumpDeck;
  if (!binding || !Number.isInteger(index) || index < 0 || index > 8) return "";
  return formatBinding({ ...binding, code: `Digit${index + 1}` });
}

// ---- Matching --------------------------------------------------------------

export type ShortcutMatch =
  | { action: "goTo" }
  | { action: "nextWaiting" }
  | { action: "nextPane" }
  | { action: "prevPane" }
  | { action: "jumpDeck"; index: number }
  | { action: "addTerminals" }
  | { action: "closePane" }
  | { action: "splitRight" }
  | { action: "splitDown" }
  | { action: "fullscreen" }
  | { action: "balance" }
  | { action: "movePane"; direction: MoveDirection }
  | { action: "newDeck" }
  | { action: "overview" }
  | { action: "toggleSidebar" }
  | { action: "toggleInspector" }
  | { action: "menuBar" };

export interface Chord {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** True when this keydown is the chord — for a family, any key in it. */
export function matchesBinding(
  event: Chord,
  binding: Binding | null,
  family: ShortcutFamily = "single",
): boolean {
  if (!binding) return false;
  if (
    event.metaKey ||
    event.ctrlKey !== binding.ctrl ||
    event.shiftKey !== binding.shift ||
    event.altKey !== binding.alt
  ) {
    return false;
  }
  if (family === "digits") return deckIndexOf(event.code) !== null;
  if (family === "arrows") return event.code in MOVES;
  return event.code === binding.code;
}

/**
 * Which app action this keydown is, if any. Rename is handled separately
 * because it only fires from a terminal, not from sidebar rows or text fields.
 */
export function matchShortcut(
  event: Chord,
  bindings: Bindings = active,
): ShortcutMatch | null {
  for (const shortcut of SHORTCUTS) {
    if (shortcut.id === "rename") continue;
    if (!matchesBinding(event, bindings[shortcut.id], shortcut.family)) continue;
    if (shortcut.id === "jumpDeck") {
      return { action: "jumpDeck", index: deckIndexOf(event.code) ?? 0 };
    }
    if (shortcut.id === "movePane") {
      return { action: "movePane", direction: MOVES[event.code] };
    }
    return { action: shortcut.id } as ShortcutMatch;
  }
  return null;
}

// ---- Recording a new chord -------------------------------------------------

/** Keys that are only ever half a chord. */
export const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
]);

export type Recorded =
  | { binding: Binding; warning: string | null }
  | { problem: string };

const TERMINAL_CHORDS: Record<string, string> = {
  KeyA: "moves to the start of the line",
  KeyC: "stops the running program",
  KeyD: "ends input",
  KeyK: "deletes to the end of the line",
  KeyL: "clears the screen",
  KeyR: "searches shell history",
  KeyU: "deletes to the start of the line",
  KeyV: "pastes",
  KeyZ: "suspends the running program",
};

/** Something worth knowing about a chord that is still allowed. */
export function bindingWarning(binding: Binding): string | null {
  if (binding.alt && binding.shift && !binding.ctrl) {
    return "Alt+Shift also switches the keyboard layout on Windows.";
  }
  if (binding.alt && !binding.ctrl && !binding.shift && binding.code === "F4") {
    return "Alt+F4 also closes the window.";
  }
  const job = TERMINAL_CHORDS[binding.code];
  if (binding.ctrl && !binding.shift && !binding.alt && job) {
    return `In a terminal, ${formatBinding(binding)} ${job}. Keel will take it first.`;
  }
  return null;
}

/** Turn a pressed chord into a binding for this kind of shortcut, or say why not. */
export function recordBinding(chord: Chord, family: ShortcutFamily): Recorded {
  if (chord.metaKey) {
    return { problem: "The Windows key belongs to Windows. Use Ctrl or Alt." };
  }
  const mods = { ctrl: chord.ctrlKey, shift: chord.shiftKey, alt: chord.altKey };
  const guarded = chord.ctrlKey || chord.altKey;

  if (family === "digits") {
    if (deckIndexOf(chord.code) === null) {
      return { problem: "Hold the modifiers and press any number from 1 to 9." };
    }
    if (!guarded) {
      return { problem: "Add Ctrl or Alt, or the numbers would be typed into terminals." };
    }
    const binding = bind("Digit1", mods);
    return { binding, warning: bindingWarning(binding) };
  }

  if (family === "arrows") {
    if (!(chord.code in MOVES)) {
      return { problem: "Hold the modifiers and press an arrow key." };
    }
    if (!guarded) {
      return { problem: "Add Ctrl or Alt, or the arrows would stop moving the cursor." };
    }
    const binding = bind("ArrowLeft", mods);
    return { binding, warning: bindingWarning(binding) };
  }

  if (chord.code === "Escape") {
    return { problem: "Esc closes menus and dialogs, so it can't be a shortcut." };
  }
  if (!guarded && !/^F\d{1,2}$/.test(chord.code)) {
    return {
      problem: `Add Ctrl or Alt. On its own, ${keyLabel(chord.code)} would be typed into terminals.`,
    };
  }
  const binding = bind(chord.code, mods);
  return { binding, warning: bindingWarning(binding) };
}

function codesOf(shortcut: Shortcut, binding: Binding): string[] {
  if (shortcut.family === "digits") return DIGIT_CODES;
  if (shortcut.family === "arrows") return ARROW_CODES;
  return [binding.code];
}

/** Other actions that already answer to (part of) this chord. */
export function conflictsWith(
  id: ShortcutId,
  binding: Binding,
  bindings: Bindings = active,
): ShortcutId[] {
  const self = shortcutById(id);
  const mine = new Set(codesOf(self, binding));
  return SHORTCUTS.filter((other) => {
    if (other.id === id) return false;
    const theirs = bindings[other.id];
    if (!theirs) return false;
    if (
      theirs.ctrl !== binding.ctrl ||
      theirs.shift !== binding.shift ||
      theirs.alt !== binding.alt
    ) {
      return false;
    }
    return codesOf(other, theirs).some((code) => mine.has(code));
  }).map((other) => other.id);
}

// ---- Focus -----------------------------------------------------------------

/**
 * True when the keydown landed in a real text field, so Ctrl+W should delete a
 * word instead of closing a pane. The xterm helper textarea is not a real text
 * field — that is the terminal, and we do want to steal from it.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as {
    classList?: { contains: (name: string) => boolean };
    isContentEditable?: boolean;
    tagName?: string;
  };
  if (el.classList?.contains("xterm-helper-textarea")) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
