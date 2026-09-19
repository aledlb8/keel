import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cwdFromOsc7, cwdFromOsc99, pathWithin } from "./terminalCwd.ts";

describe("cwdFromOsc99", () => {
  it("takes a raw windows path", () => {
    assert.equal(cwdFromOsc99("C:\\Users\\dev\\code\\keel"), "C:\\Users\\dev\\code\\keel");
    assert.equal(cwdFromOsc99("C:/Users/dev"), "C:/Users/dev");
  });

  it("takes a drive root, a posix path and a UNC share", () => {
    assert.equal(cwdFromOsc99("C:\\"), "C:\\");
    assert.equal(cwdFromOsc99("/home/dev/code/keel"), "/home/dev/code/keel");
    assert.equal(cwdFromOsc99("\\\\server\\share"), "\\\\server\\share");
  });

  it("unwraps the quoted form", () => {
    assert.equal(cwdFromOsc99('"C:\\My Code\\keel"'), "C:\\My Code\\keel");
  });

  it("keeps spaces, unicode and punctuation", () => {
    const path = "C:\\My Code (beta)\\café#1";
    assert.equal(cwdFromOsc99(path), path);
  });

  it("refuses relative paths, the empty payload and stray controls", () => {
    assert.equal(cwdFromOsc99("src\\components"), null);
    assert.equal(cwdFromOsc99("keel"), null);
    assert.equal(cwdFromOsc99(""), null);
    assert.equal(cwdFromOsc99("   "), null);
    assert.equal(cwdFromOsc99("C:\\x\u001b]0;evil"), null);
    assert.equal(cwdFromOsc99("/home/\u007f"), null);
  });
});

describe("cwdFromOsc7", () => {
  it("reads a windows file url, with the drive as first segment", () => {
    assert.equal(cwdFromOsc7("file:///C:/Users/dev/code/keel"), "C:\\Users\\dev\\code\\keel");
  });

  it("decodes percent escapes back into folder names", () => {
    assert.equal(cwdFromOsc7("file:///C:/My%20Code/café"), "C:\\My Code\\café");
  });

  it("reads posix paths and an explicit localhost authority", () => {
    assert.equal(cwdFromOsc7("file:///home/dev/code/keel"), "/home/dev/code/keel");
    assert.equal(cwdFromOsc7("file://localhost/home/dev"), "/home/dev");
    assert.equal(cwdFromOsc7("file://localhost/C:/Users/dev"), "C:\\Users\\dev");
  });

  it("refuses other schemes, foreign hosts and junk", () => {
    assert.equal(cwdFromOsc7("https://example.com/code"), null);
    assert.equal(cwdFromOsc7("file://othermachine/home"), null);
    assert.equal(cwdFromOsc7("C:\\Users\\dev"), null);
    assert.equal(cwdFromOsc7(""), null);
    assert.equal(cwdFromOsc7("file:///C:/a%zz"), null);
    assert.equal(cwdFromOsc7("file:///C:/x\u001b"), null);
  });
});

describe("pathWithin", () => {
  const keel = "C:\\Users\\dev\\code\\keel";

  it("accepts the root and folders inside it", () => {
    assert.equal(pathWithin(keel, keel), true);
    assert.equal(pathWithin("C:\\Users\\dev\\code\\keel\\src\\components", keel), true);
  });

  it("compares windows paths without case and across separators", () => {
    assert.equal(pathWithin("c:/Users/DEV/code/Keel/src", keel), true);
  });

  it("refuses siblings that share a prefix, and everything above", () => {
    assert.equal(pathWithin("C:\\Users\\dev\\code\\keel-www", keel), false);
    assert.equal(pathWithin("C:\\Users\\dev\\code", keel), false);
    assert.equal(pathWithin("C:\\Windows", keel), false);
  });

  it("compares posix paths with case", () => {
    assert.equal(pathWithin("/home/dev/code/keel/src", "/home/dev/code/keel"), true);
    assert.equal(pathWithin("/home/dev/code/KEEL", "/home/dev/code/keel"), false);
  });

  it("handles a drive root and a UNC root", () => {
    assert.equal(pathWithin("C:\\Users", "C:\\"), true);
    assert.equal(pathWithin("C:\\other", "C:\\"), true);
    assert.equal(pathWithin("\\\\server\\share\\src", "\\\\server\\share"), true);
    assert.equal(pathWithin("\\\\other\\share\\src", "\\\\server\\share"), false);
  });

  it("refuses an empty root", () => {
    assert.equal(pathWithin("/anything", ""), false);
  });
});
