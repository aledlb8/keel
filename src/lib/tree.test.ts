/**
 * The layout tree is the only part of Keel that is pure logic, and it is the part
 * that goes wrong invisibly — a bad move leaves a plausible-looking layout that is
 * simply not what you asked for. These run under Node's built-in test runner:
 * `pnpm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  balance,
  besideTree,
  closePane,
  dockPane,
  gridOf,
  gridRows,
  listPanes,
  movePane,
  relabelPanes,
  splitPane,
  swapPanes,
} from "./tree.ts";
import type { LayoutNode } from "./types.ts";

/** Nested arrays, so an assertion reads like the layout it describes. */
type Shape = string | { row: Shape[] } | { column: Shape[] } | null;

function shape(node: LayoutNode | null): Shape {
  if (!node) return null;
  if (node.kind === "pane") return node.id;
  return node.direction === "row"
    ? { row: node.children.map(shape) }
    : { column: node.children.map(shape) };
}

const SIX = ["a", "b", "c", "d", "e", "f"];

describe("relabelPanes", () => {
  it("swaps terminals without changing the layout's shape", () => {
    const tree = gridOf(["a", "b", "c"])!;
    const next = relabelPanes(tree, ["c", "a", "b"]);
    assert.deepEqual(shape(next), { column: [{ row: ["c", "a"] }, "b"] });
    assert.deepEqual(listPanes(next), ["c", "a", "b"]);
  });

  it("ignores an order that is not a permutation of the tree", () => {
    const tree = gridOf(["a", "b"])!;
    assert.equal(relabelPanes(tree, ["a", "z"]), tree);
    assert.equal(relabelPanes(tree, ["a"]), tree);
  });
});

describe("gridOf", () => {
  it("lays six panes out as two rows of three", () => {
    assert.deepEqual(shape(gridOf(SIX)), {
      column: [{ row: ["a", "b", "c"] }, { row: ["d", "e", "f"] }],
    });
  });

  it("returns a bare pane rather than a split of one", () => {
    assert.deepEqual(shape(gridOf(["a"])), "a");
  });
});

describe("swapPanes", () => {
  it("trades two panes and keeps the grid's shape", () => {
    assert.deepEqual(shape(swapPanes(gridOf(SIX)!, "a", "f")), {
      column: [{ row: ["f", "b", "c"] }, { row: ["d", "e", "a"] }],
    });
  });
});

describe("dockPane", () => {
  it("drops below a pane by stacking the two", () => {
    assert.deepEqual(shape(dockPane(gridOf(["a", "b"])!, "a", "b", "bottom")), {
      column: ["b", "a"],
    });
  });

  it("joins a row on the left of its target, before it", () => {
    assert.deepEqual(shape(dockPane(gridOf(["a", "b", "c"])!, "c", "a", "left")), {
      row: ["c", "a", "b"],
    });
  });

  it("docks along the edge of the whole layout", () => {
    const four = gridOf(["a", "b", "c", "d"])!;
    const tree = dockPane(four, "d", four.id, "right");
    assert.deepEqual(shape(tree), {
      row: [{ column: [{ row: ["a", "b"] }, "c"] }, "d"],
    });
    assert.ok(tree.kind === "split");
    assert.deepEqual(tree.sizes, [0.75, 0.25]);
  });

  it("joins the end of a group that runs the same way", () => {
    const four = gridOf(["a", "b", "c", "d"])!;
    assert.ok(four.kind === "split");
    const topRow = four.children[0]?.id;
    assert.ok(topRow);
    assert.deepEqual(shape(dockPane(four, "d", topRow, "right")), {
      column: [{ row: ["a", "b", "d"] }, "c"],
    });
  });

  it("leaves the tree alone when a pane is dropped on itself", () => {
    const tree = gridOf(SIX)!;
    assert.equal(dockPane(tree, "a", "a", "right"), tree);
  });
});

describe("besideTree", () => {
  it("keeps both layouts intact and sizes them by pane count", () => {
    const tree = besideTree(gridOf(["a", "b", "c"])!, gridOf(["d"])!);
    assert.deepEqual(shape(tree), {
      row: [{ column: [{ row: ["a", "b"] }, "c"] }, "d"],
    });
    assert.ok(tree.kind === "split");
    assert.deepEqual(tree.sizes, [0.75, 0.25]);
  });
});

describe("gridRows", () => {
  it("fills ceil(sqrt(n)) columns and leaves the remainder on the last row", () => {
    assert.deepEqual(gridRows(["a", "b", "c", "d", "e"]), [
      ["a", "b", "c"],
      ["d", "e"],
    ]);
  });

  it("has no rows for nothing", () => {
    assert.deepEqual(gridRows([]), []);
  });
});

describe("movePane", () => {
  const six = gridOf(SIX)!;

  it("swaps with the pane beside it", () => {
    assert.deepEqual(shape(movePane(six, "a", "right")), {
      column: [{ row: ["b", "a", "c"] }, { row: ["d", "e", "f"] }],
    });
  });

  it("enters the row below at the edge it arrives from", () => {
    assert.deepEqual(shape(movePane(six, "b", "down")), {
      column: [{ row: ["a", "c"] }, { row: ["b", "d", "e", "f"] }],
    });
  });

  it("enters the row above at its far edge", () => {
    assert.deepEqual(shape(movePane(six, "e", "up")), {
      column: [{ row: ["a", "b", "c", "e"] }, { row: ["d", "f"] }],
    });
  });

  // The outermost edge used to wrap the whole root in a new split, which handed
  // one pane half the screen for a single arrow press.
  for (const [pane, direction] of [
    ["a", "left"],
    ["b", "up"],
    ["e", "down"],
    ["f", "right"],
  ] as const) {
    it(`does nothing moving ${pane} ${direction} off the edge`, () => {
      assert.deepEqual(shape(movePane(six, pane, direction)), shape(six));
    });
  }

  it("never loses or duplicates a pane", () => {
    for (const direction of ["left", "right", "up", "down"] as const) {
      for (const pane of SIX) {
        assert.deepEqual(listPanes(movePane(six, pane, direction)).sort(), SIX);
      }
    }
  });
});

describe("splitPane", () => {
  it("keeps repeated same-way splits flat instead of nesting", () => {
    let tree: LayoutNode = { kind: "pane", id: "a" };
    tree = splitPane(tree, "a", "row", "b");
    tree = splitPane(tree, "b", "row", "c");
    assert.deepEqual(shape(tree), { row: ["a", "b", "c"] });
  });

  it("nests when the split runs the other way", () => {
    const tree = splitPane(
      splitPane({ kind: "pane", id: "a" }, "a", "row", "b"),
      "b",
      "column",
      "c",
    );
    assert.deepEqual(shape(tree), { row: ["a", { column: ["b", "c"] }] });
  });

  it("leaves sizes summing to one", () => {
    let tree: LayoutNode = { kind: "pane", id: "a" };
    tree = splitPane(tree, "a", "row", "b");
    tree = splitPane(tree, "b", "row", "c");
    assert.equal(tree.kind, "split");
    if (tree.kind !== "split") return;
    const total = tree.sizes.reduce((sum, size) => sum + size, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `sizes summed to ${total}`);
  });
});

describe("closePane", () => {
  it("collapses a split down to its last surviving child", () => {
    const tree = splitPane({ kind: "pane", id: "a" }, "a", "column", "b");
    assert.deepEqual(shape(closePane(tree, "b")), "a");
  });

  it("returns null once the last pane goes", () => {
    assert.equal(closePane({ kind: "pane", id: "a" }, "a"), null);
  });
});

describe("balance", () => {
  it("evens out a split that has been dragged around", () => {
    const uneven: LayoutNode = {
      kind: "split",
      id: "s",
      direction: "row",
      children: [
        { kind: "pane", id: "a" },
        { kind: "pane", id: "b" },
        { kind: "pane", id: "c" },
      ],
      sizes: [0.7, 0.2, 0.1],
    };
    const evened = balance(uneven);
    assert.equal(evened.kind, "split");
    if (evened.kind !== "split") return;
    for (const size of evened.sizes) {
      assert.ok(Math.abs(size - 1 / 3) < 1e-9);
    }
  });
});
