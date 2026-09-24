import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";

import { startWindowFocusTracking } from "./windowFocus.ts";

let focused = false;
let events: EventTarget;
let dataset: Record<string, string | undefined>;
let stop: (() => void) | undefined;

beforeEach(() => {
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
});

function setFocus(next: boolean) {
  focused = next;
  events.dispatchEvent(new Event(next ? "focus" : "blur"));
}

it("starts from the focus the window already has", () => {
  focused = false;
  stop = startWindowFocusTracking();
  assert.equal(dataset.windowInactive, "true");
});

it("marks the shell inactive only while the window is in the background", () => {
  focused = true;
  stop = startWindowFocusTracking();
  assert.equal(dataset.windowInactive, undefined);
  setFocus(false);
  assert.equal(dataset.windowInactive, "true");
  setFocus(true);
  assert.equal(dataset.windowInactive, undefined);
});

it("goes quiet and leaves nothing behind when it stops", () => {
  stop = startWindowFocusTracking();
  const stopNow = stop;
  stop = undefined;

  stopNow();
  assert.equal(dataset.windowInactive, undefined);
  setFocus(false);
  assert.equal(dataset.windowInactive, undefined);
});
