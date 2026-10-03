import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  changeStarts,
  hiddenBefore,
  pairLines,
  segments,
  splitRows,
  wordDiff,
} from "./diffView.ts";
import type { DiffLine, GitHunk } from "./workspace.ts";

const line = (kind: DiffLine["kind"], text = ""): DiffLine => ({
  kind,
  text,
  oldNo: null,
  newNo: null,
});

const hunk = (oldStart: number, oldLines: number, lines: DiffLine[] = []): GitHunk => ({
  header: "",
  oldStart,
  oldLines,
  newStart: oldStart,
  newLines: oldLines,
  lines,
});

describe("wordDiff", () => {
  it("marks only the words that changed", () => {
    const before = "const total = a + b;";
    const after = "const total = a - c;";
    const result = wordDiff(before, after);
    assert.ok(result);
    assert.deepEqual(result.removed.map(([s, e]) => before.slice(s, e)), ["+", "b"]);
    assert.deepEqual(result.added.map(([s, e]) => after.slice(s, e)), ["-", "c"]);
  });

  it("gives up on lines with too little in common", () => {
    assert.equal(wordDiff("import x from 'y';", "return 42;"), null);
  });

  it("finds nothing to mark in equal lines", () => {
    assert.deepEqual(wordDiff("same", "same"), { removed: [], added: [] });
  });
});

describe("pairLines", () => {
  it("pairs removals with the additions that follow them, in order", () => {
    const pairs = pairLines([
      line("ctx"),
      line("del"),
      line("del"),
      line("add"),
      line("ctx"),
      line("add"),
    ]);
    assert.equal(pairs.get(1), 3);
    assert.equal(pairs.get(3), 1);
    assert.equal(pairs.has(2), false);
    assert.equal(pairs.has(5), false);
  });
});

describe("splitRows", () => {
  it("lines up a change block and pads the shorter side", () => {
    const rows = splitRows([line("ctx"), line("del"), line("add"), line("add"), line("ctx")]);
    assert.deepEqual(rows, [
      { left: 0, right: 0 },
      { left: 1, right: 2 },
      { left: null, right: 3 },
      { left: 4, right: 4 },
    ]);
  });

  it("keeps the no-newline note beside its line", () => {
    const rows = splitRows([line("del"), line("meta"), line("add")]);
    assert.deepEqual(rows[1], { left: 1, right: null });
  });
});

describe("changeStarts", () => {
  it("finds each run of changes once", () => {
    const starts = changeStarts([
      hunk(1, 5, [line("ctx"), line("del"), line("add"), line("ctx"), line("add")]),
      hunk(20, 2, [line("add")]),
    ]);
    assert.deepEqual(starts, [
      { hunk: 0, line: 1 },
      { hunk: 0, line: 4 },
      { hunk: 1, line: 0 },
    ]);
  });
});

describe("hiddenBefore", () => {
  it("counts the unchanged lines git left out", () => {
    const hunks = [hunk(5, 6), hunk(20, 4)];
    assert.equal(hiddenBefore(hunks, 0), 4);
    assert.equal(hiddenBefore(hunks, 1), 9);
  });
});

describe("segments", () => {
  it("cuts where colour or change starts and ends", () => {
    const out = segments("let x = 1;", [{ from: 0, to: 3, style: 4 }], [[8, 9]]);
    assert.deepEqual(out, [
      { text: "let", style: 4, changed: false },
      { text: " x = ", style: null, changed: false },
      { text: "1", style: null, changed: true },
      { text: ";", style: null, changed: false },
    ]);
  });
});
