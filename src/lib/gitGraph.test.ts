import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { layoutGraph } from "./gitGraph.ts";

const lanes = (edges: { lane: number }[]) => edges.map((edge) => edge.lane);

describe("layoutGraph", () => {
  it("keeps a straight history in one lane", () => {
    const rows = layoutGraph([
      { hash: "c", parents: ["b"] },
      { hash: "b", parents: ["a"] },
      { hash: "a", parents: [] },
    ]);
    assert.deepEqual(rows.map((row) => row.lane), [0, 0, 0]);
    assert.deepEqual(lanes(rows[0]!.incoming), []);
    assert.deepEqual(lanes(rows[1]!.incoming), [0]);
    assert.deepEqual(lanes(rows[2]!.outgoing), []);
    assert.ok(rows.every((row) => row.width === 1));
  });

  it("opens a lane for a merge's second parent and closes it where they meet", () => {
    //   m        merge of a feature into main
    //   |\
    //   | f      feature commit
    //   b |      main commit
    //   |/
    //   a
    const rows = layoutGraph([
      { hash: "m", parents: ["b", "f"] },
      { hash: "f", parents: ["a"] },
      { hash: "b", parents: ["a"] },
      { hash: "a", parents: [] },
    ]);
    const [merge, feature, main, base] = rows;
    assert.deepEqual(lanes(merge!.outgoing), [0, 1]);
    assert.equal(feature!.lane, 1);
    assert.deepEqual(lanes(feature!.through), [0]);
    // Nothing waits for a yet, so the feature keeps its own lane down to it.
    assert.deepEqual(lanes(feature!.outgoing), [1]);
    assert.equal(main!.lane, 0);
    // Main reaches a second: it joins the feature's lane rather than doubling it.
    assert.deepEqual(lanes(main!.outgoing), [1]);
    assert.equal(base!.lane, 1);
    assert.deepEqual(lanes(base!.incoming), [1]);
  });

  it("gives each branch tip its own lane and colour", () => {
    const rows = layoutGraph([
      { hash: "x", parents: ["a"] },
      { hash: "y", parents: ["a"] },
      { hash: "a", parents: [] },
    ]);
    assert.equal(rows[0]!.lane, 0);
    assert.equal(rows[1]!.lane, 1);
    assert.notEqual(rows[0]!.color, rows[1]!.color);
    // y's parent is already awaited in x's lane, so y curves straight into it
    // instead of running a second line alongside down to a.
    assert.deepEqual(lanes(rows[1]!.outgoing), [0]);
    assert.deepEqual(lanes(rows[2]!.incoming), [0]);
    assert.equal(rows[2]!.lane, 0);
  });

  it("says which lanes carry on below a row", () => {
    const rows = layoutGraph([
      { hash: "m", parents: ["b", "f"] },
      { hash: "b", parents: ["a"] },
    ]);
    assert.deepEqual(lanes(rows[0]!.after), [0, 1]);
    assert.deepEqual(lanes(rows[1]!.after), [0, 1]);
  });
});
