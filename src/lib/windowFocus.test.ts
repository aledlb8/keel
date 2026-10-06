import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";

import { AWAY_DELAY_MS, startWindowFocusTracking } from "./windowFocus.ts";

let focused = false;
let events: EventTarget;
let dataset: Record<string, string | undefined>;
let stop: (() => void) | undefined;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  focused = false;
  events = new EventTarget();
  dataset = {};
  Object.assign(globalThis, {
    window: events,
    document: { hasFocus: () => focused, documentElement: { dataset } },
  });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  mock.timers.reset();
});

function setFocus(next: boolean) {
  focused = next;
  events.dispatchEvent(new Event(next ? "focus" : "blur"));
}

it("starts from the focus the window already has", () => {
  focused = false;
  stop = startWindowFocusTracking();
  assert.equal(dataset.windowInactive, undefined);
  mock.timers.tick(AWAY_DELAY_MS);
  assert.equal(dataset.windowInactive, "true");
});

it("fades only once the window has been away for the full delay", () => {
  focused = true;
  stop = startWindowFocusTracking();
  assert.equal(dataset.windowInactive, undefined);
  setFocus(false);
  mock.timers.tick(AWAY_DELAY_MS - 1);
  assert.equal(dataset.windowInactive, undefined);
  mock.timers.tick(1);
  assert.equal(dataset.windowInactive, "true");
  setFocus(true);
  assert.equal(dataset.windowInactive, undefined);
});

it("a brief trip away never fades, and does not shorten the next one", () => {
  focused = true;
  stop = startWindowFocusTracking();
  setFocus(false);
  mock.timers.tick(AWAY_DELAY_MS - 1);
  setFocus(true);
  setFocus(false);
  mock.timers.tick(AWAY_DELAY_MS - 1);
  assert.equal(dataset.windowInactive, undefined);
  mock.timers.tick(1);
  assert.equal(dataset.windowInactive, "true");
});

it("goes quiet and leaves nothing behind when it stops", () => {
  stop = startWindowFocusTracking();
  const stopNow = stop;
  stop = undefined;

  stopNow();
  mock.timers.tick(AWAY_DELAY_MS);
  assert.equal(dataset.windowInactive, undefined);
  setFocus(false);
  mock.timers.tick(AWAY_DELAY_MS);
  assert.equal(dataset.windowInactive, undefined);
});
