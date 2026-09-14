import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { moveTo } from "./order.ts";

const is = (value: string) => (item: string) => item === value;

describe("moveTo", () => {
  it("moves an item to the front", () => {
    assert.deepEqual(moveTo(["a", "b", "c"], is("c"), 0), ["c", "a", "b"]);
  });

  it("moves an item to the end", () => {
    assert.deepEqual(moveTo(["a", "b", "c"], is("a"), 2), ["b", "c", "a"]);
  });

  it("counts the index without the moved item", () => {
    assert.deepEqual(moveTo(["a", "b", "c", "d"], is("a"), 2), ["b", "c", "a", "d"]);
  });

  it("returns the same array when nothing changes", () => {
    const items = ["a", "b", "c"];
    assert.equal(moveTo(items, is("b"), 1), items);
    assert.equal(moveTo(items, is("z"), 0), items);
  });

  it("clamps out-of-range indices", () => {
    assert.deepEqual(moveTo(["a", "b", "c"], is("b"), 99), ["a", "c", "b"]);
    assert.deepEqual(moveTo(["a", "b", "c"], is("b"), -4), ["b", "a", "c"]);
  });
});
