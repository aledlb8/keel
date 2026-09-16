import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isTerminalFindChord,
  type FindChord,
} from "./terminalFind.ts";

function chord(
  code: string,
  mods: Partial<Omit<FindChord, "code">> = {},
): FindChord {
  return {
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  };
}

describe("isTerminalFindChord", () => {
  it("opens on Ctrl+F", () => {
    assert.equal(isTerminalFindChord(chord("KeyF", { ctrlKey: true })), "open");
  });

  it("finds next on Ctrl+G and F3", () => {
    assert.equal(isTerminalFindChord(chord("KeyG", { ctrlKey: true })), "next");
    assert.equal(isTerminalFindChord(chord("F3")), "next");
  });

  it("finds previous on Shift+F3", () => {
    assert.equal(isTerminalFindChord(chord("F3", { shiftKey: true })), "previous");
  });

  it("ignores Cmd+F, Alt+F, and Ctrl+Shift+F so they cannot steal from the editor", () => {
    assert.equal(isTerminalFindChord(chord("KeyF", { metaKey: true })), null);
    assert.equal(isTerminalFindChord(chord("KeyF", { altKey: true })), null);
    assert.equal(
      isTerminalFindChord(chord("KeyF", { ctrlKey: true, shiftKey: true })),
      null,
    );
    assert.equal(
      isTerminalFindChord(chord("KeyF", { ctrlKey: true, metaKey: true })),
      null,
    );
  });

  it("leaves ordinary typing and other Ctrl chords alone", () => {
    assert.equal(isTerminalFindChord(chord("KeyF")), null);
    assert.equal(isTerminalFindChord(chord("KeyV", { ctrlKey: true })), null);
    assert.equal(isTerminalFindChord(chord("Enter")), null);
    assert.equal(isTerminalFindChord(chord("Escape")), null);
    assert.equal(isTerminalFindChord(chord("F3", { ctrlKey: true })), null);
  });
});
