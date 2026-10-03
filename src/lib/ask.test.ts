import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ask, setAsker } from "./ask.ts";

function withConfirm(confirm: ((text: string) => unknown) | undefined) {
  Object.assign(globalThis, { window: confirm ? { confirm } : {} });
}

describe("ask", () => {
  afterEach(() => setAsker(null));

  it("uses the mounted dialog and its answer", async () => {
    let asked = "";
    setAsker(async (message) => {
      asked = message;
      return false;
    });
    withConfirm(() => true);
    assert.equal(await ask("Discard?"), false);
    assert.equal(asked, "Discard?");
  });

  it("never reads a pending promise as yes", async () => {
    // Tauri's dialog plugin makes window.confirm async; when it is not
    // allowed the promise rejects. That must be a no, not a truthy object.
    withConfirm(() => Promise.reject(new Error("dialog.confirm not allowed")));
    assert.equal(await ask("Discard?"), false);
    withConfirm(() => Promise.resolve(true));
    assert.equal(await ask("Discard?"), true);
  });

  it("says no when there is nothing to ask with", async () => {
    withConfirm(undefined);
    assert.equal(await ask("Discard?"), false);
  });
});
