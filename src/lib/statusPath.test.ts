import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shortenPath, statusPlace } from "./statusPath.ts";

const keel = { name: "keel", path: "C:\\Users\\dev\\code\\keel" };
const posix = { name: "keel", path: "/home/dev/code/keel" };

describe("shortenPath", () => {
  it("keeps the last few segments and marks what it dropped", () => {
    assert.equal(shortenPath("/home/dev/code/keel/src"), "…/code/keel/src");
    assert.equal(shortenPath("/a/b/c"), "a/b/c");
    assert.equal(shortenPath("/a/b/c/d"), "…/b/c/d");
  });

  it("reads Windows separators and ignores a trailing one", () => {
    assert.equal(shortenPath("C:\\Users\\dev\\code\\keel\\"), "…/dev/code/keel");
  });
});

describe("statusPlace", () => {
  it("names the project, and a bare slash for its root", () => {
    assert.deepEqual(statusPlace(keel.path, keel), { root: "keel", tail: "/" });
  });

  it("spends the line on where you are inside the project", () => {
    assert.deepEqual(statusPlace("C:\\Users\\dev\\code\\keel\\src\\components", keel), {
      root: "keel",
      tail: "/src/components",
    });
  });

  it("compares Windows paths without case, POSIX paths with it", () => {
    assert.deepEqual(statusPlace("c:/users/DEV/code/Keel/src", keel), {
      root: "keel",
      tail: "/src",
    });
    assert.equal(statusPlace("/home/dev/code/KEEL/src", posix).root, null);
  });

  it("elides a deep tail from the front, keeping what is specific", () => {
    assert.deepEqual(
      statusPlace("/home/dev/code/keel/src/components/menu/ui", posix),
      { root: "keel", tail: "/…/components/menu/ui" },
    );
  });

  it("drops the anchor when the terminal has left the project", () => {
    assert.deepEqual(statusPlace("/tmp/scratch/deep/inner", posix), {
      root: null,
      tail: "…/scratch/deep/inner",
    });
  });

  it("does not mistake a sibling folder for being inside", () => {
    assert.equal(statusPlace("/home/dev/code/keel-www", posix).root, null);
  });

  it("falls back to the project path, and to nothing at all", () => {
    assert.deepEqual(statusPlace(null, posix), { root: "keel", tail: "/" });
    assert.deepEqual(statusPlace(null, null), { root: null, tail: null });
  });
});
