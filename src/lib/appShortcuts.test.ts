import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isAppModalOpen,
  isBrowserChromeKey,
  isWindowManagementAction,
  radixDialogOpen,
  shouldIgnoreAppShortcut,
  type ShortcutEvent,
} from "./appShortcuts.ts";

function key(
  code: string,
  mods: Partial<Omit<ShortcutEvent, "code">> = {},
): ShortcutEvent {
  return {
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    ...mods,
  };
}

describe("isBrowserChromeKey", () => {
  it("treats F5 and Ctrl+F5 as reload", () => {
    assert.equal(isBrowserChromeKey(key("F5")), true);
    assert.equal(isBrowserChromeKey(key("F5", { ctrlKey: true })), true);
    assert.equal(
      isBrowserChromeKey(key("F5", { ctrlKey: true, shiftKey: true })),
      true,
    );
  });

  it("treats Ctrl+R and Ctrl+Shift+R as reload", () => {
    assert.equal(isBrowserChromeKey(key("KeyR", { ctrlKey: true })), true);
    assert.equal(
      isBrowserChromeKey(key("KeyR", { ctrlKey: true, shiftKey: true })),
      true,
    );
    assert.equal(isBrowserChromeKey(key("KeyR")), false);
  });

  it("treats Ctrl+plus/minus/0 as zoom", () => {
    assert.equal(isBrowserChromeKey(key("Equal", { ctrlKey: true })), true);
    assert.equal(isBrowserChromeKey(key("Minus", { ctrlKey: true })), true);
    assert.equal(isBrowserChromeKey(key("Digit0", { ctrlKey: true })), true);
    assert.equal(
      isBrowserChromeKey(key("Equal", { ctrlKey: true, shiftKey: true })),
      true,
    );
    assert.equal(isBrowserChromeKey(key("Equal")), false);
    assert.equal(isBrowserChromeKey(key("Digit0")), false);
  });

  it("treats Cmd as the accelerator so macOS WebKit is covered too", () => {
    assert.equal(isBrowserChromeKey(key("KeyR", { metaKey: true })), true);
    assert.equal(isBrowserChromeKey(key("Equal", { metaKey: true })), true);
    assert.equal(isBrowserChromeKey(key("Digit0", { metaKey: true })), true);
  });

  it("leaves ordinary app and terminal chords alone", () => {
    assert.equal(isBrowserChromeKey(key("KeyW", { ctrlKey: true })), false);
    assert.equal(isBrowserChromeKey(key("KeyT", { ctrlKey: true })), false);
    assert.equal(
      isBrowserChromeKey(key("KeyF", { ctrlKey: true, shiftKey: true })),
      false,
    );
    assert.equal(isBrowserChromeKey(key("KeyN", { ctrlKey: true })), false);
    assert.equal(isBrowserChromeKey(key("Tab", { ctrlKey: true })), false);
  });
});

describe("shouldIgnoreAppShortcut", () => {
  it("ignores auto-repeat so holding Ctrl+W cannot drain panes", () => {
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyW", { ctrlKey: true, repeat: true }), {
        modalOpen: false,
      }),
      true,
    );
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyW", { ctrlKey: true }), {
        modalOpen: false,
        repeat: true,
      }),
      true,
    );
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyW", { ctrlKey: true }), {
        modalOpen: false,
      }),
      false,
    );
  });

  it("blocks close, split, jump, move and new-deck while a modal is open", () => {
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyW", { ctrlKey: true }), {
        modalOpen: true,
      }),
      true,
    );
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyD", { ctrlKey: true, shiftKey: true }), {
        modalOpen: true,
      }),
      true,
    );
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyS", { ctrlKey: true, shiftKey: true }), {
        modalOpen: true,
      }),
      true,
    );
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyN", { ctrlKey: true }), {
        modalOpen: true,
      }),
      true,
    );
    assert.equal(
      shouldIgnoreAppShortcut(
        key("ArrowLeft", { ctrlKey: true, shiftKey: true }),
        { modalOpen: true },
      ),
      true,
    );
    assert.equal(
      shouldIgnoreAppShortcut(key("Digit2", { ctrlKey: true }), {
        modalOpen: true,
      }),
      true,
    );
    assert.equal(
      shouldIgnoreAppShortcut(key("Tab", { ctrlKey: true }), {
        modalOpen: true,
      }),
      true,
    );
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyP", { ctrlKey: true }), {
        modalOpen: true,
      }),
      true,
    );
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyT", { ctrlKey: true }), {
        modalOpen: true,
      }),
      true,
    );
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyO", { ctrlKey: true }), {
        modalOpen: true,
      }),
      true,
    );
  });

  it("still allows find in files and view chords behind a dialog", () => {
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyF", { ctrlKey: true, shiftKey: true }), {
        modalOpen: true,
      }),
      false,
    );
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyB", { ctrlKey: true }), {
        modalOpen: true,
      }),
      false,
    );
    assert.equal(
      shouldIgnoreAppShortcut(key("F10"), { modalOpen: true }),
      false,
    );
  });

  it("does not block window-management when nothing modal is open", () => {
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyW", { ctrlKey: true }), {
        modalOpen: false,
      }),
      false,
    );
    assert.equal(
      shouldIgnoreAppShortcut(key("KeyD", { ctrlKey: true, shiftKey: true }), {
        modalOpen: false,
      }),
      false,
    );
  });

  it("repeat wins even when the chord is find in files", () => {
    assert.equal(
      shouldIgnoreAppShortcut(
        key("KeyF", { ctrlKey: true, shiftKey: true, repeat: true }),
        { modalOpen: false },
      ),
      true,
    );
  });
});

describe("isWindowManagementAction", () => {
  it("names the destructive pane/deck chords and not find-in-files", () => {
    assert.equal(isWindowManagementAction("closePane"), true);
    assert.equal(isWindowManagementAction("splitRight"), true);
    assert.equal(isWindowManagementAction("splitDown"), true);
    assert.equal(isWindowManagementAction("movePane"), true);
    assert.equal(isWindowManagementAction("newDeck"), true);
    assert.equal(isWindowManagementAction("findInFiles"), false);
    assert.equal(isWindowManagementAction("toggleSidebar"), false);
    assert.equal(isWindowManagementAction("menuBar"), false);
  });
});

describe("isAppModalOpen", () => {
  it("is true for any listed overlay", () => {
    assert.equal(isAppModalOpen({}), false);
    assert.equal(isAppModalOpen({ radixDialog: true }), true);
    assert.equal(isAppModalOpen({ agentSettings: true }), true);
    assert.equal(isAppModalOpen({ vpnDialog: true }), true);
    assert.equal(isAppModalOpen({ launcher: true }), true);
    assert.equal(isAppModalOpen({ switcher: true }), true);
    assert.equal(isAppModalOpen({ restoreFailed: true }), true);
    assert.equal(isAppModalOpen({ shortcuts: true }), true);
  });
});

describe("radixDialogOpen", () => {
  it("looks for an open Radix dialog", () => {
    assert.equal(
      radixDialogOpen({
        querySelector: (sel) =>
          sel === '[role="dialog"][data-state="open"]' ? {} : null,
      }),
      true,
    );
    assert.equal(
      radixDialogOpen({ querySelector: () => null }),
      false,
    );
  });
});
