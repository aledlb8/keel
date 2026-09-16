import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { markFor } from "./agentMark.ts";

const MARKS = { shell: "prompt", claude: "starburst" };

describe("markFor", () => {
  it("falls back to shell when the id is missing", () => {
    assert.equal(markFor(MARKS, null), "prompt");
    assert.equal(markFor(MARKS, undefined), "prompt");
  });

  it("returns a known catalogue mark", () => {
    assert.equal(markFor(MARKS, "claude"), "starburst");
  });

  it("ignores prototype keys instead of throwing or inheriting", () => {
    assert.equal(markFor(MARKS, "__proto__"), undefined);
    assert.equal(markFor(MARKS, "constructor"), undefined);
    assert.equal(markFor(MARKS, "toString"), undefined);
  });

  it("falls back for an unknown custom agent", () => {
    assert.equal(markFor(MARKS, "my-agent"), undefined);
  });
});
