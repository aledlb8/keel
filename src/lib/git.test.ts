import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aheadBehind,
  diffStats,
  fileName,
  folderStatuses,
  gitBadgeMap,
  gitLetter,
  gitStatusLabel,
  groupGitFiles,
  joinRel,
  parentRel,
  relativeTime,
  splitHunkHeader,
} from "./git.ts";
import type { GitFile } from "./workspace.ts";

function file(over: Partial<GitFile> & { path: string }): GitFile {
  return {
    origPath: null,
    status: "modified",
    staged: false,
    unstaged: false,
    untracked: false,
    conflict: false,
    ...over,
  };
}

describe("groupGitFiles", () => {
  it("splits staged, unstaged, untracked and conflict", () => {
    const groups = groupGitFiles([
      file({ path: "a.ts", staged: true, unstaged: true }),
      file({ path: "b.ts", untracked: true, unstaged: true, status: "untracked" }),
      file({ path: "c.ts", conflict: true, unstaged: true, status: "conflict" }),
      file({ path: "d.ts", staged: true, status: "added" }),
    ]);
    assert.equal(groups.conflict.length, 1);
    assert.equal(groups.untracked.length, 1);
    assert.equal(groups.staged.length, 2);
    assert.equal(groups.unstaged.length, 1);
    assert.equal(groups.staged[0]?.path, "a.ts");
    assert.equal(groups.unstaged[0]?.path, "a.ts");
  });
});

describe("path helpers", () => {
  it("joins and splits relative paths", () => {
    assert.equal(joinRel("src", "lib/git.ts"), "src/lib/git.ts");
    assert.equal(parentRel("src/lib/git.ts"), "src/lib");
    assert.equal(parentRel("git.ts"), "");
    assert.equal(fileName("src/lib/git.ts"), "git.ts");
  });
});

describe("labels", () => {
  it("prints ahead/behind in plain language", () => {
    assert.equal(aheadBehind(0, 0), null);
    assert.equal(aheadBehind(2, 0), "2 ahead");
    assert.equal(aheadBehind(0, 1), "1 behind");
    assert.equal(aheadBehind(2, 1), "2 ahead, 1 behind");
  });

  it("maps status to a letter", () => {
    assert.equal(gitLetter("modified"), "M");
    assert.equal(gitLetter("untracked"), "U");
    assert.equal(gitLetter("conflict"), "!");
  });

  it("prefers conflict then unstaged when decorating the tree", () => {
    const map = gitBadgeMap([
      file({ path: "a.ts", staged: true, status: "added" }),
      file({ path: "a.ts", unstaged: true, status: "modified" }),
      file({ path: "b.ts", conflict: true, status: "conflict" }),
    ]);
    assert.equal(map["a.ts"], "modified");
    assert.equal(map["b.ts"], "conflict");
  });

  it("names every status", () => {
    assert.equal(gitStatusLabel("modified"), "Modified");
    assert.equal(gitStatusLabel("typechange"), "Type changed");
  });
});

describe("folderStatuses", () => {
  it("marks every ancestor of a change, and nothing at the root", () => {
    const folders = folderStatuses([
      file({ path: "src/lib/git.ts" }),
      file({ path: "src/App.tsx" }),
      file({ path: "README.md" }),
    ]);
    assert.deepEqual(Object.keys(folders).sort(), ["src", "src/lib"]);
  });

  it("gives a folder the worst status below it", () => {
    const folders = folderStatuses([
      file({ path: "src/a.ts", status: "untracked" }),
      file({ path: "src/lib/b.ts", status: "modified" }),
      file({ path: "src/lib/c.ts", status: "conflict" }),
      file({ path: "docs/d.md", status: "added" }),
    ]);
    assert.equal(folders["src"], "conflict");
    assert.equal(folders["src/lib"], "conflict");
    assert.equal(folders["docs"], "added");
  });
});

describe("diffs", () => {
  it("counts added and removed lines across hunks", () => {
    const stats = diffStats({
      path: "a.ts",
      binary: false,
      hunks: [
        {
          header: "@@ -1,2 +1,3 @@",
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
            { kind: "del", text: "b", oldNo: 2, newNo: null },
            { kind: "add", text: "c", oldNo: null, newNo: 2 },
            { kind: "add", text: "d", oldNo: null, newNo: 3 },
            { kind: "meta", text: "\\ No newline", oldNo: null, newNo: null },
          ],
        },
      ],
    });
    assert.deepEqual(stats, { added: 2, removed: 1 });
  });

  it("splits a hunk header into its range and context", () => {
    assert.deepEqual(splitHunkHeader("@@ -12,6 +12,8 @@ fn main() {"), {
      range: "@@ -12,6 +12,8 @@",
      context: "fn main() {",
    });
    assert.deepEqual(splitHunkHeader("@@ -0,0 +1,4 @@"), {
      range: "@@ -0,0 +1,4 @@",
      context: "",
    });
    assert.deepEqual(splitHunkHeader("garbage"), { range: "garbage", context: "" });
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;
  const ago = (seconds: number) => now / 1000 - seconds;

  it("reads like a person would say it", () => {
    assert.equal(relativeTime(ago(5), now), "just now");
    assert.equal(relativeTime(ago(5 * 60), now), "5m ago");
    assert.equal(relativeTime(ago(3 * 3600), now), "3h ago");
    assert.equal(relativeTime(ago(2 * 86400), now), "2d ago");
    assert.equal(relativeTime(ago(14 * 86400), now), "2w ago");
    assert.equal(relativeTime(ago(90 * 86400), now), "3mo ago");
    assert.equal(relativeTime(ago(800 * 86400), now), "2y ago");
  });

  it("never goes negative for a clock slightly ahead", () => {
    assert.equal(relativeTime(ago(-30), now), "just now");
  });
});
