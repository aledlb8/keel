import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { looksLikeHostDeath } from "./invoke.ts";

describe("looksLikeHostDeath", () => {
  it("treats webview IPC failures as a dead host", () => {
    assert.equal(looksLikeHostDeath("error sending to webview"), true);
    assert.equal(looksLikeHostDeath("failed to communicate with the main process"), true);
    assert.equal(looksLikeHostDeath("IPC command failed"), true);
    assert.equal(looksLikeHostDeath("Tauri API unavailable"), true);
  });

  it("does not treat git or HTTP network errors as host death", () => {
    assert.equal(looksLikeHostDeath("Could not run git: connection refused"), false);
    assert.equal(looksLikeHostDeath("fatal: unable to access: connection reset"), false);
    assert.equal(looksLikeHostDeath("connection lost"), false);
    assert.equal(looksLikeHostDeath("connection closed"), false);
  });

  it("reads Error messages and empty rejects", () => {
    assert.equal(looksLikeHostDeath(new Error("error sending to webview")), true);
    assert.equal(looksLikeHostDeath(""), true);
  });
});
