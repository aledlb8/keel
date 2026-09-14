import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bindingParts,
  conflictsWith,
  deckIndexOf,
  deckShortcutKeys,
  formatBinding,
  isCustomized,
  isEditableTarget,
  matchShortcut,
  readKeybindingOverrides,
  recordBinding,
  resolveBindings,
  setKeybindingOverrides,
  shortcutById,
  shortcutKeys,
  withOverride,
  withShortcut,
  withoutOverride,
  type Binding,
  type Chord,
} from "./keymap.ts";

function binding(code: string, mods: Partial<Omit<Binding, "code">> = {}): Binding {
  return { code, ctrl: false, shift: false, alt: false, ...mods };
}

function chord(
  code: string,
  mods: Partial<Omit<Chord, "code">> = {},
): Chord {
  return {
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  };
}

describe("matchShortcut", () => {
  it("maps the browser-like Ctrl chords", () => {
    assert.deepEqual(matchShortcut(chord("KeyT", { ctrlKey: true })), {
      action: "addTerminals",
    });
    assert.deepEqual(matchShortcut(chord("KeyW", { ctrlKey: true })), {
      action: "closePane",
    });
    assert.deepEqual(matchShortcut(chord("KeyN", { ctrlKey: true })), {
      action: "newDeck",
    });
    assert.deepEqual(matchShortcut(chord("KeyP", { ctrlKey: true })), {
      action: "goTo",
    });
    assert.deepEqual(matchShortcut(chord("KeyO", { ctrlKey: true })), {
      action: "overview",
    });
    assert.deepEqual(matchShortcut(chord("KeyB", { ctrlKey: true })), {
      action: "toggleSidebar",
    });
    assert.deepEqual(matchShortcut(chord("Tab", { ctrlKey: true })), {
      action: "nextPane",
    });
  });

  it("uses Shift only for chords that would steal a terminal key", () => {
    assert.deepEqual(
      matchShortcut(chord("KeyD", { ctrlKey: true, shiftKey: true })),
      { action: "splitRight" },
    );
    assert.deepEqual(
      matchShortcut(chord("KeyS", { ctrlKey: true, shiftKey: true })),
      { action: "splitDown" },
    );
    assert.deepEqual(
      matchShortcut(chord("KeyE", { ctrlKey: true, shiftKey: true })),
      { action: "balance" },
    );
    assert.deepEqual(
      matchShortcut(chord("Tab", { ctrlKey: true, shiftKey: true })),
      { action: "prevPane" },
    );
  });

  it("does not steal bare Ctrl+D, Ctrl+S or Ctrl+E from the terminal", () => {
    assert.equal(matchShortcut(chord("KeyD", { ctrlKey: true })), null);
    assert.equal(matchShortcut(chord("KeyS", { ctrlKey: true })), null);
    assert.equal(matchShortcut(chord("KeyE", { ctrlKey: true })), null);
  });

  it("does not claim keys the shell uses without our modifier", () => {
    assert.equal(matchShortcut(chord("KeyC", { ctrlKey: true })), null);
    assert.equal(matchShortcut(chord("KeyL", { ctrlKey: true })), null);
    assert.equal(matchShortcut(chord("KeyR", { ctrlKey: true })), null);
    assert.equal(matchShortcut(chord("KeyT")), null);
    assert.equal(matchShortcut(chord("Tab")), null);
  });

  it("ignores Alt+Shift, the old scheme and the Windows layout switcher", () => {
    assert.equal(
      matchShortcut(chord("KeyT", { altKey: true, shiftKey: true })),
      null,
    );
    assert.equal(
      matchShortcut(chord("KeyW", { altKey: true, shiftKey: true })),
      null,
    );
  });

  it("ignores chords with the Windows key held", () => {
    assert.equal(
      matchShortcut(chord("KeyT", { ctrlKey: true, metaKey: true })),
      null,
    );
  });

  it("maps Ctrl+1…9 to deck indices", () => {
    assert.deepEqual(matchShortcut(chord("Digit1", { ctrlKey: true })), {
      action: "jumpDeck",
      index: 0,
    });
    assert.deepEqual(matchShortcut(chord("Digit9", { ctrlKey: true })), {
      action: "jumpDeck",
      index: 8,
    });
    assert.equal(matchShortcut(chord("Digit0", { ctrlKey: true })), null);
  });

  it("maps Ctrl+Shift+arrows to pane moves", () => {
    assert.deepEqual(
      matchShortcut(chord("ArrowLeft", { ctrlKey: true, shiftKey: true })),
      { action: "movePane", direction: "left" },
    );
    assert.deepEqual(
      matchShortcut(chord("ArrowDown", { ctrlKey: true, shiftKey: true })),
      { action: "movePane", direction: "down" },
    );
    assert.equal(
      matchShortcut(chord("ArrowLeft", { ctrlKey: true })),
      null,
    );
  });

  it("maps the unmodified function keys", () => {
    assert.deepEqual(matchShortcut(chord("F8")), { action: "nextWaiting" });
    assert.deepEqual(matchShortcut(chord("F11")), { action: "fullscreen" });
    assert.equal(matchShortcut(chord("F8", { shiftKey: true })), null);
    assert.equal(matchShortcut(chord("F11", { ctrlKey: true })), null);
  });

  it("opens the menu bar on F10, the Windows convention", () => {
    assert.deepEqual(matchShortcut(chord("F10")), { action: "menuBar" });
    assert.equal(matchShortcut(chord("F10", { shiftKey: true })), null);
  });

  it("leaves F2 to the rename handler", () => {
    assert.equal(matchShortcut(chord("F2")), null);
  });
});

describe("deckIndexOf", () => {
  it("maps Digit1–Digit9 and nothing else", () => {
    assert.equal(deckIndexOf("Digit1"), 0);
    assert.equal(deckIndexOf("Digit9"), 8);
    assert.equal(deckIndexOf("Digit0"), null);
    assert.equal(deckIndexOf("KeyT"), null);
  });
});

describe("shortcutKeys", () => {
  it("is the string the rest of the app prints", () => {
    assert.equal(shortcutKeys("addTerminals"), "Ctrl+T");
    assert.equal(shortcutKeys("closePane"), "Ctrl+W");
    assert.equal(shortcutKeys("goTo"), "Ctrl+P");
    assert.equal(shortcutKeys("nextWaiting"), "F8");
  });
});

describe("formatBinding", () => {
  it("reads families as the keys they cover", () => {
    assert.equal(shortcutKeys("jumpDeck"), "Ctrl+1…9");
    assert.equal(shortcutKeys("movePane"), "Ctrl+Shift+←/→/↑/↓");
    assert.equal(shortcutKeys("splitRight"), "Ctrl+Shift+D");
  });

  it("names punctuation and keeps modifiers in a fixed order", () => {
    assert.equal(
      formatBinding(binding("Backquote", { alt: true, ctrl: true, shift: true })),
      "Ctrl+Shift+Alt+`",
    );
    assert.deepEqual(bindingParts(binding("KeyK", { ctrl: true })), ["Ctrl", "K"]);
  });
});

describe("overrides", () => {
  it("answer to the new chord and not the old one", () => {
    const bindings = resolveBindings({ goTo: binding("KeyK", { ctrl: true }) });
    assert.deepEqual(matchShortcut(chord("KeyK", { ctrlKey: true }), bindings), {
      action: "goTo",
    });
    assert.equal(matchShortcut(chord("KeyP", { ctrlKey: true }), bindings), null);
  });

  it("can remove a shortcut altogether", () => {
    const bindings = resolveBindings({ closePane: null });
    assert.equal(matchShortcut(chord("KeyW", { ctrlKey: true }), bindings), null);
  });

  it("change families by their modifiers", () => {
    const bindings = resolveBindings({ jumpDeck: binding("Digit1", { alt: true }) });
    assert.deepEqual(matchShortcut(chord("Digit4", { altKey: true }), bindings), {
      action: "jumpDeck",
      index: 3,
    });
    assert.equal(matchShortcut(chord("Digit4", { ctrlKey: true }), bindings), null);
  });

  it("drop out when set back to the default", () => {
    const custom = withOverride({}, "goTo", binding("KeyK", { ctrl: true }));
    assert.equal(isCustomized("goTo", custom), true);
    assert.deepEqual(withOverride(custom, "goTo", shortcutById("goTo").defaults), {});
    assert.deepEqual(withoutOverride(custom, "goTo"), {});
    assert.equal(isCustomized("goTo", { goTo: shortcutById("goTo").defaults }), false);
  });

  it("reach every label the app prints once applied", () => {
    setKeybindingOverrides({ splitRight: binding("Backslash", { ctrl: true }), rename: null });
    try {
      assert.equal(shortcutKeys("splitRight"), "Ctrl+\\");
      assert.equal(withShortcut("Split right", "splitRight"), "Split right (Ctrl+\\)");
      assert.equal(shortcutKeys("rename"), "");
      assert.equal(withShortcut("Rename", "rename"), "Rename");
    } finally {
      setKeybindingOverrides({});
    }
    assert.equal(shortcutKeys("splitRight"), "Ctrl+Shift+D");
  });
});

describe("deckShortcutKeys", () => {
  it("names the chord for one deck, following the family's modifiers", () => {
    assert.equal(deckShortcutKeys(2), "Ctrl+3");
    assert.equal(deckShortcutKeys(9), "");
    setKeybindingOverrides({ jumpDeck: binding("Digit1", { alt: true }) });
    try {
      assert.equal(deckShortcutKeys(0), "Alt+1");
    } finally {
      setKeybindingOverrides({ jumpDeck: null });
    }
    try {
      assert.equal(deckShortcutKeys(0), "");
    } finally {
      setKeybindingOverrides({});
    }
  });
});

describe("readKeybindingOverrides", () => {
  it("keeps good entries and drops the rest", () => {
    assert.deepEqual(
      readKeybindingOverrides({
        goTo: { code: "KeyK", ctrl: true },
        closePane: null,
        jumpDeck: { code: "Digit7", alt: true },
        movePane: { code: "KeyX", ctrl: true },
        nope: { code: "KeyZ" },
        overview: "Ctrl+O",
      }),
      {
        goTo: binding("KeyK", { ctrl: true }),
        closePane: null,
        jumpDeck: binding("Digit1", { alt: true }),
      },
    );
    assert.deepEqual(readKeybindingOverrides(null), {});
    assert.deepEqual(readKeybindingOverrides([1, 2]), {});
  });
});

describe("recordBinding", () => {
  it("takes a guarded chord or a function key", () => {
    assert.deepEqual(recordBinding(chord("KeyJ", { ctrlKey: true }), "single"), {
      binding: binding("KeyJ", { ctrl: true }),
      warning: null,
    });
    assert.deepEqual(recordBinding(chord("F5"), "single"), {
      binding: binding("F5"),
      warning: null,
    });
  });

  it("refuses keys that would type into a terminal, Esc and the Windows key", () => {
    assert.ok("problem" in recordBinding(chord("KeyK"), "single"));
    assert.ok("problem" in recordBinding(chord("KeyK", { shiftKey: true }), "single"));
    assert.ok("problem" in recordBinding(chord("Escape", { ctrlKey: true }), "single"));
    assert.ok("problem" in recordBinding(chord("KeyK", { metaKey: true }), "single"));
  });

  it("keeps families to their keys", () => {
    assert.deepEqual(
      recordBinding(chord("Digit6", { altKey: true }), "digits"),
      { binding: binding("Digit1", { alt: true }), warning: null },
    );
    assert.ok("problem" in recordBinding(chord("KeyK", { altKey: true }), "digits"));
    assert.ok("problem" in recordBinding(chord("Digit6"), "digits"));
    assert.ok("problem" in recordBinding(chord("KeyK", { ctrlKey: true }), "arrows"));
  });

  it("warns about chords that do something else too", () => {
    const stolen = recordBinding(chord("KeyC", { ctrlKey: true }), "single");
    assert.ok("binding" in stolen && stolen.warning?.includes("stops the running program"));
    const layout = recordBinding(chord("KeyK", { altKey: true, shiftKey: true }), "single");
    assert.ok("binding" in layout && layout.warning?.includes("keyboard layout"));
  });
});

describe("conflictsWith", () => {
  const defaults = resolveBindings({});

  it("finds the action that already has a chord", () => {
    assert.deepEqual(
      conflictsWith("goTo", binding("KeyT", { ctrl: true }), defaults),
      ["addTerminals"],
    );
    assert.deepEqual(conflictsWith("goTo", binding("KeyK", { ctrl: true }), defaults), []);
  });

  it("sees a single chord inside a family, and the other way round", () => {
    assert.deepEqual(
      conflictsWith("goTo", binding("Digit3", { ctrl: true }), defaults),
      ["jumpDeck"],
    );
    assert.deepEqual(
      conflictsWith("jumpDeck", binding("Digit1", { ctrl: true, shift: true }), resolveBindings({
        balance: binding("Digit5", { ctrl: true, shift: true }),
      })),
      ["balance"],
    );
    assert.deepEqual(
      conflictsWith("overview", binding("ArrowUp", { ctrl: true, shift: true }), defaults),
      ["movePane"],
    );
  });

  it("ignores its own chord and unbound actions", () => {
    assert.deepEqual(conflictsWith("goTo", binding("KeyP", { ctrl: true }), defaults), []);
    assert.deepEqual(
      conflictsWith("goTo", binding("KeyT", { ctrl: true }), resolveBindings({ addTerminals: null })),
      [],
    );
  });
});

describe("isEditableTarget", () => {
  it("lets us steal from the xterm helper textarea", () => {
    assert.equal(
      isEditableTarget({
        classList: { contains: (name: string) => name === "xterm-helper-textarea" },
        tagName: "TEXTAREA",
      } as unknown as EventTarget),
      false,
    );
  });

  it("leaves real inputs alone", () => {
    assert.equal(
      isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget),
      true,
    );
    assert.equal(
      isEditableTarget({ tagName: "TEXTAREA" } as unknown as EventTarget),
      true,
    );
    assert.equal(
      isEditableTarget({ isContentEditable: true } as unknown as EventTarget),
      true,
    );
    assert.equal(
      isEditableTarget({ tagName: "BUTTON" } as unknown as EventTarget),
      false,
    );
    assert.equal(isEditableTarget(null), false);
  });
});
