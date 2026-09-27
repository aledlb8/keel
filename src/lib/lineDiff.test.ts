import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { lineChanges, splitLines, type LineChange } from "./lineDiff.ts";

function changes(before: string, after: string): LineChange[] {
  return lineChanges(splitLines(before), splitLines(after));
}

describe("splitLines", () => {
  it("counts lines the way git does", () => {
    assert.deepEqual(splitLines(""), []);
    assert.deepEqual(splitLines("a"), ["a"]);
    assert.deepEqual(splitLines("a\n"), ["a"]);
    assert.deepEqual(splitLines("a\n\n"), ["a", ""]);
    assert.deepEqual(splitLines("a\r\nb\r\n"), ["a", "b"]);
  });
});

describe("lineChanges", () => {
  it("finds nothing in an untouched file", () => {
    assert.deepEqual(changes("a\nb\nc\n", "a\nb\nc\n"), []);
  });

  it("ignores CRLF against an LF commit", () => {
    assert.deepEqual(changes("a\nb\n", "a\r\nb\r\n"), []);
  });

  it("marks inserted lines as added", () => {
    assert.deepEqual(changes("a\nb\n", "a\nx\ny\nb\n"), [
      { kind: "added", from: 1, to: 3, removed: 0 },
    ]);
  });

  it("marks lines typed after the last one as added", () => {
    assert.deepEqual(changes("a\nb\n", "a\nb\nc"), [
      { kind: "added", from: 2, to: 3, removed: 0 },
    ]);
  });

  it("marks a rewritten line as modified", () => {
    assert.deepEqual(changes("a\nb\nc\n", "a\nB\nc\n"), [
      { kind: "modified", from: 1, to: 2, removed: 1 },
    ]);
  });

  it("marks every new line of a replacement as modified", () => {
    assert.deepEqual(changes("a\nb\nc\n", "a\nx\ny\nz\nc\n"), [
      { kind: "modified", from: 1, to: 4, removed: 1 },
    ]);
  });

  it("puts a deletion between the lines around it", () => {
    assert.deepEqual(changes("a\nb\nc\nd\n", "a\nd\n"), [
      { kind: "deleted", from: 1, to: 1, removed: 2 },
    ]);
  });

  it("handles deletions at either end", () => {
    assert.deepEqual(changes("a\nb\nc\n", "b\nc\n"), [
      { kind: "deleted", from: 0, to: 0, removed: 1 },
    ]);
    assert.deepEqual(changes("a\nb\nc\n", "a\nb\n"), [
      { kind: "deleted", from: 2, to: 2, removed: 1 },
    ]);
  });

  it("reads a file with no commit as all added", () => {
    assert.deepEqual(changes("", "a\nb\n"), [{ kind: "added", from: 0, to: 2, removed: 0 }]);
    assert.deepEqual(changes("", ""), []);
  });

  it("keeps separate hunks apart through repeated lines", () => {
    const before = "fn a() {\n  one\n}\n\nfn b() {\n  two\n}\n";
    const after = "fn a() {\n  ONE\n}\n\nfn b() {\n  two\n  three\n}\n";
    assert.deepEqual(changes(before, after), [
      { kind: "modified", from: 1, to: 2, removed: 1 },
      { kind: "added", from: 6, to: 7, removed: 0 },
    ]);
  });

  it("reports one change when the edit budget runs out", () => {
    const before = Array.from({ length: 1500 }, (_, i) => `line ${i}`);
    const after = [...before].reverse();
    assert.deepEqual(lineChanges(before, after), [
      { kind: "modified", from: 0, to: 1500, removed: 1500 },
    ]);
  });

  it("matches a longest common subsequence on random edits", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = (length: number) =>
      Array.from({ length }, () => "abcde"[Math.floor(random() * 5)]!);

    for (let round = 0; round < 400; round += 1) {
      const before = pick(Math.floor(random() * 14));
      const after = pick(Math.floor(random() * 14));
      const found = lineChanges(before, after);

      // Walking the changes must replay `after` from `before`.
      let i = 0;
      let j = 0;
      let kept = 0;
      for (const change of found) {
        while (j < change.from) {
          assert.equal(before[i], after[j]);
          i += 1;
          j += 1;
          kept += 1;
        }
        assert.equal(change.kind === "deleted", change.from === change.to);
        assert.equal(change.kind === "added", change.removed === 0);
        i += change.removed;
        j = change.to;
      }
      while (j < after.length) {
        assert.equal(before[i], after[j]);
        i += 1;
        j += 1;
        kept += 1;
      }
      assert.equal(i, before.length);
      assert.equal(kept, lcsLength(before, after), `${before.join("")} → ${after.join("")}`);
    }
  });
});

function lcsLength(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const line of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = line === b[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1]!);
      diagonal = above;
    }
  }
  return row[b.length]!;
}
