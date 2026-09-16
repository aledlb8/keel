import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clampReveal } from "./editorViews.ts";

describe("clampReveal", () => {
  it("keeps a line and column that already sit in the document", () => {
    assert.deepEqual(clampReveal(20, 12, 4, 8), { line: 4, offset: 7 });
  });

  it("clamps a line below 1 and a column past the end of the line", () => {
    assert.deepEqual(clampReveal(10, 5, 0, 99), { line: 1, offset: 5 });
    assert.deepEqual(clampReveal(10, 5, -3, 0), { line: 1, offset: 0 });
  });

  it("clamps a line past the last line", () => {
    assert.deepEqual(clampReveal(3, 8, 40, 2), { line: 3, offset: 1 });
  });

  it("treats a missing column as the start of the line", () => {
    assert.deepEqual(clampReveal(6, 10, 2), { line: 2, offset: 0 });
  });

  it("handles an empty document as a single empty line", () => {
    assert.deepEqual(clampReveal(0, 0, 1, 1), { line: 1, offset: 0 });
    assert.deepEqual(clampReveal(1, 0, 1, 1), { line: 1, offset: 0 });
  });
});
