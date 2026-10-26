import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPaintBeat, pacePainting, type Timers } from "./paintPace.ts";

/** Timers that only fire when the test says so. */
function manualTimers() {
  const live = new Map<number, () => void>();
  let next = 0;
  const timers: Timers = {
    set(callback) {
      next += 1;
      live.set(next, callback);
      return next;
    },
    clear(handle) {
      live.delete(handle as number);
    },
  };
  return {
    timers,
    get scheduled() {
      return live.size;
    },
    fire() {
      const due = [...live.values()];
      live.clear();
      for (const callback of due) callback();
    },
  };
}

function recorder() {
  const calls: [number | undefined, number | undefined, number][] = [];
  return {
    calls,
    refresher: {
      refresh(start: number | undefined, end: number | undefined, count: number) {
        calls.push([start, end, count]);
      },
    },
  };
}

describe("paint beat", () => {
  it("runs everything waiting together, once", () => {
    const clock = manualTimers();
    const beat = createPaintBeat(66, clock.timers);
    const ran: string[] = [];
    const a = () => ran.push("a");
    const b = () => ran.push("b");
    beat.wait(a);
    beat.wait(b);
    beat.wait(a);
    assert.equal(clock.scheduled, 1);
    clock.fire();
    assert.deepEqual(ran, ["a", "b"]);
    assert.equal(clock.scheduled, 0);
  });

  it("schedules nothing when nothing waits", () => {
    const clock = manualTimers();
    const beat = createPaintBeat(66, clock.timers);
    const paint = () => {};
    beat.wait(paint);
    beat.drop(paint);
    assert.equal(clock.scheduled, 0);
  });
});

describe("paced painting", () => {
  it("passes repaints straight through while the terminal is used", () => {
    const clock = manualTimers();
    const { calls, refresher } = recorder();
    pacePainting(refresher, createPaintBeat(66, clock.timers), true);
    refresher.refresh(2, 3, 30);
    assert.deepEqual(calls, [[2, 3, 30]]);
    assert.equal(clock.scheduled, 0);
  });

  it("merges repaints into one range on the beat while not used", () => {
    const clock = manualTimers();
    const { calls, refresher } = recorder();
    pacePainting(refresher, createPaintBeat(66, clock.timers));
    refresher.refresh(5, 6, 30);
    refresher.refresh(1, 2, 30);
    refresher.refresh(10, 10, 30);
    assert.deepEqual(calls, []);
    clock.fire();
    assert.deepEqual(calls, [[1, 10, 30]]);
  });

  it("reads a missing bound as the whole screen", () => {
    const clock = manualTimers();
    const { calls, refresher } = recorder();
    pacePainting(refresher, createPaintBeat(66, clock.timers));
    refresher.refresh(undefined, undefined, 24);
    clock.fire();
    assert.deepEqual(calls, [[0, 23, 24]]);
  });

  it("paints what is waiting at once when it becomes used", () => {
    const clock = manualTimers();
    const { calls, refresher } = recorder();
    const paced = pacePainting(refresher, createPaintBeat(66, clock.timers));
    refresher.refresh(4, 4, 30);
    paced.setUsed(true);
    assert.deepEqual(calls, [[4, 4, 30]]);
    assert.equal(clock.scheduled, 0);
    refresher.refresh(7, 8, 30);
    assert.deepEqual(calls, [[4, 4, 30], [7, 8, 30]]);
  });

  it("paints what is waiting at once when flushed, and stays paced", () => {
    const clock = manualTimers();
    const { calls, refresher } = recorder();
    const paced = pacePainting(refresher, createPaintBeat(66, clock.timers));
    paced.flush();
    assert.deepEqual(calls, []);
    refresher.refresh(0, 29, 30);
    paced.flush();
    assert.deepEqual(calls, [[0, 29, 30]]);
    assert.equal(clock.scheduled, 0);
    refresher.refresh(3, 3, 30);
    assert.equal(calls.length, 1);
    assert.equal(clock.scheduled, 1);
  });

  it("repaints a group of terminals on the same beat", () => {
    const clock = manualTimers();
    const beat = createPaintBeat(66, clock.timers);
    const first = recorder();
    const second = recorder();
    pacePainting(first.refresher, beat);
    pacePainting(second.refresher, beat);
    first.refresher.refresh(0, 1, 30);
    second.refresher.refresh(3, 3, 30);
    assert.equal(clock.scheduled, 1);
    clock.fire();
    assert.deepEqual(first.calls, [[0, 1, 30]]);
    assert.deepEqual(second.calls, [[3, 3, 30]]);
  });

  it("paints nothing after it is disposed", () => {
    const clock = manualTimers();
    const { calls, refresher } = recorder();
    const paced = pacePainting(refresher, createPaintBeat(66, clock.timers));
    refresher.refresh(0, 0, 30);
    paced.dispose();
    assert.equal(clock.scheduled, 0);
    clock.fire();
    assert.deepEqual(calls, []);
  });
});
