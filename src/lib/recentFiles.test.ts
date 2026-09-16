import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  clearRecent,
  isRecent,
  noteRecent,
  pruneRecent,
  recentAt,
  recentFolders,
  RECENT_MS,
} from "./recentFiles.ts";

describe("recent files", { concurrency: 1 }, () => {
  beforeEach(() => {
    pruneRecent(Number.MAX_SAFE_INTEGER);
  });

  it("stamps a file and each ancestor folder", () => {
    noteRecent("p", ["src/lib/foo.ts"], 1_000);
    assert.equal(recentAt("p", "src/lib/foo.ts"), 1_000);
    assert.equal(recentAt("p", "src/lib"), 1_000);
    assert.equal(recentAt("p", "src"), 1_000);
    assert.equal(recentAt("p", "missing"), 0);
    assert.deepEqual([...recentFolders("p", 1_000)].sort(), ["src", "src/lib"]);
  });

  it("ignores the empty rel that means a full refresh", () => {
    noteRecent("p", ["", "src/a.ts"], 1_000);
    assert.equal(recentAt("p", ""), 0);
    assert.equal(isRecent("p", "", 1_000), false);
    assert.equal(isRecent("p", "src/a.ts", 1_000), true);
    assert.deepEqual([...recentFolders("p", 1_000)], ["src"]);
  });

  it("treats a stamp as recent only inside the five-minute window", () => {
    noteRecent("p", ["a.ts"], 1_000);
    assert.equal(isRecent("p", "a.ts", 1_000), true);
    assert.equal(isRecent("p", "a.ts", 1_000 + RECENT_MS - 1), true);
    assert.equal(isRecent("p", "a.ts", 1_000 + RECENT_MS), false);
  });

  it("keeps the newest stamp when an ancestor is touched again", () => {
    noteRecent("p", ["src/a.ts"], 1_000);
    noteRecent("p", ["src/b.ts"], 2_000);
    assert.equal(recentAt("p", "src/a.ts"), 1_000);
    assert.equal(recentAt("p", "src/b.ts"), 2_000);
    assert.equal(recentAt("p", "src"), 2_000);
  });

  it("isolates stamps per root", () => {
    noteRecent("one", ["a.ts"], 1_000);
    noteRecent("two", ["b.ts"], 1_000);
    assert.equal(isRecent("one", "a.ts", 1_000), true);
    assert.equal(isRecent("one", "b.ts", 1_000), false);
    clearRecent("one");
    assert.equal(isRecent("one", "a.ts", 1_000), false);
    assert.equal(isRecent("two", "b.ts", 1_000), true);
  });

  it("prunes stamps older than the window", () => {
    noteRecent("p", ["old.ts", "src/keep.ts"], 1_000);
    noteRecent("p", ["src/keep.ts"], 1_000 + RECENT_MS);
    pruneRecent(1_000 + RECENT_MS);
    assert.equal(recentAt("p", "old.ts"), 0);
    assert.equal(recentAt("p", "src/keep.ts"), 1_000 + RECENT_MS);
    assert.equal(recentAt("p", "src"), 1_000 + RECENT_MS);
    assert.deepEqual([...recentFolders("p", 1_000 + RECENT_MS)], ["src"]);
  });
});
