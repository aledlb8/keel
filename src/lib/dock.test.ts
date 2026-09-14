import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dropTargetAt, dropZoneAt, paneAt, zoneBox } from "./dock.ts";
import { gridOf } from "./tree.ts";

const BOX = { left: 100, top: 100, width: 400, height: 200 };

describe("dropZoneAt", () => {
  it("docks against the nearest edge inside its band", () => {
    assert.equal(dropZoneAt(BOX, 110, 200), "left");
    assert.equal(dropZoneAt(BOX, 490, 200), "right");
    assert.equal(dropZoneAt(BOX, 300, 105), "top");
    assert.equal(dropZoneAt(BOX, 300, 295), "bottom");
  });

  it("swaps in the middle", () => {
    assert.equal(dropZoneAt(BOX, 300, 200), "center");
  });
});

describe("zoneBox", () => {
  it("covers the half of the target the pane will take", () => {
    assert.deepEqual(zoneBox(BOX, "right"), {
      left: 300,
      top: 100,
      width: 200,
      height: 200,
    });
    assert.deepEqual(zoneBox(BOX, "top"), {
      left: 100,
      top: 100,
      width: 400,
      height: 100,
    });
  });
});

describe("paneAt", () => {
  it("finds the pane under the point, or none in a gap", () => {
    const boxes = { a: BOX, b: { ...BOX, left: 520 } };
    assert.equal(paneAt(boxes, 530, 150), "b");
    assert.equal(paneAt(boxes, 510, 150), null);
    assert.equal(paneAt(boxes, 504, 150, 6), "a");
  });
});

describe("dropTargetAt", () => {
  // Three panes side by side: a | b | c, each 100 wide with a 12px gap.
  const tree = gridOf(["a", "b", "c"])!;
  const boxes = {
    a: { left: 0, top: 0, width: 100, height: 300 },
    b: { left: 112, top: 0, width: 100, height: 300 },
    c: { left: 224, top: 0, width: 100, height: 300 },
  };

  it("docks along the whole layout right at a shared outer edge", () => {
    const target = dropTargetAt(tree, boxes, "c", 150, 295);
    assert.equal(target?.nodeId, tree.id);
    assert.equal(target?.zone, "bottom");
    assert.equal(target?.box.width, 324);
  });

  it("docks against the pane itself further in", () => {
    assert.deepEqual(
      [dropTargetAt(tree, boxes, "c", 150, 250)?.nodeId, dropTargetAt(tree, boxes, "c", 150, 250)?.zone],
      ["b", "bottom"],
    );
  });

  it("swaps in the middle, and offers nothing in the middle of the dragged pane", () => {
    assert.equal(dropTargetAt(tree, boxes, "c", 160, 150)?.zone, "center");
    assert.equal(dropTargetAt(tree, boxes, "c", 270, 150), null);
  });
});
