import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  alertCopy,
  notifyAgent,
  shouldAlert,
  type AgentAlert,
} from "./agentNotify.ts";

const ready: AgentAlert = {
  kind: "done",
  paneId: "pane_1",
  title: "Claude",
  projectName: "keel",
  muted: false,
  windowFocused: false,
  restoring: false,
  silentPane: false,
};

const yes = { notify: true, chime: true };
const no = { notify: false, chime: false };

describe("shouldAlert", () => {
  it("fires when an unfocused agent pane finishes or dies", () => {
    assert.deepEqual(shouldAlert(ready), yes);
    assert.deepEqual(shouldAlert({ ...ready, kind: "exited" }), yes);
  });

  it("is silent while the window has focus", () => {
    assert.deepEqual(shouldAlert({ ...ready, windowFocused: true }), no);
    assert.deepEqual(shouldAlert({ ...ready, kind: "exited", windowFocused: true }), no);
  });

  it("is silent for a muted pane", () => {
    assert.deepEqual(shouldAlert({ ...ready, muted: true }), no);
    assert.deepEqual(shouldAlert({ ...ready, kind: "exited", muted: true }), no);
  });

  it("is silent during restore", () => {
    assert.deepEqual(shouldAlert({ ...ready, restoring: true }), no);
    assert.deepEqual(shouldAlert({ ...ready, kind: "exited", restoring: true }), no);
  });

  it("is silent for an editor or a pane with no agent", () => {
    assert.deepEqual(shouldAlert({ ...ready, silentPane: true }), no);
    assert.deepEqual(shouldAlert({ ...ready, kind: "exited", silentPane: true }), no);
  });

  it("any suppressor wins", () => {
    assert.deepEqual(
      shouldAlert({
        ...ready,
        muted: true,
        windowFocused: true,
        restoring: true,
        silentPane: true,
      }),
      no,
    );
  });
});

describe("alertCopy", () => {
  it("names a finished pane and where it is waiting", () => {
    assert.deepEqual(alertCopy(ready), {
      title: "Claude finished",
      body: "Waiting in keel",
    });
  });

  it("drops the body when the project is unknown", () => {
    assert.deepEqual(alertCopy({ ...ready, projectName: "" }), {
      title: "Claude finished",
      body: "",
    });
  });

  it("says the process stopped when a pane exits", () => {
    assert.deepEqual(alertCopy({ ...ready, kind: "exited" }), {
      title: "Claude exited",
      body: "The agent process stopped",
    });
  });
});

describe("notifyAgent", () => {
  it("does not throw without a notification plugin or audio device", () => {
    const previous = {
      window: (globalThis as { window?: unknown }).window,
      document: (globalThis as { document?: unknown }).document,
    };
    Object.assign(globalThis, {
      window: {},
      document: { hasFocus: () => false },
    });
    try {
      assert.doesNotThrow(() => notifyAgent(ready));
      assert.doesNotThrow(() => notifyAgent({ ...ready, kind: "exited" }));
      assert.doesNotThrow(() => notifyAgent({ ...ready, windowFocused: true }));
    } finally {
      Object.assign(globalThis, previous);
    }
  });
});
