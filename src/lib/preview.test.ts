import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extensionOf, formatBytes, hexRows, previewKind, previewUrl } from "./preview.ts";

describe("preview kind", () => {
  it("goes by the name for media", () => {
    assert.equal(previewKind("assets/logo.PNG"), "image");
    assert.equal(previewKind("clips/demo.webm"), "video");
    assert.equal(previewKind("sfx/ding.mp3"), "audio");
    assert.equal(previewKind("docs/spec.pdf"), "pdf");
    assert.equal(previewKind("fonts/Inter.woff2"), "font");
  });

  it("trusts a sniffed database over any name", () => {
    assert.equal(previewKind("data/app.db", "sqlite"), "sqlite");
    assert.equal(previewKind("cache", "sqlite"), "sqlite");
    assert.equal(previewKind("weird.png", "sqlite"), "sqlite");
  });

  it("falls back to the sniff, then to bytes", () => {
    assert.equal(previewKind("thumbnail", "image"), "image");
    assert.equal(previewKind("blob.bin", "video"), "video");
    assert.equal(previewKind("blob.bin", null), "hex");
    assert.equal(previewKind("data/app.db"), "hex");
    assert.equal(previewKind("program.exe", "nonsense"), "hex");
  });

  it("reads extensions from the file name only", () => {
    assert.equal(extensionOf("src/a.b/README"), "");
    assert.equal(extensionOf(".gitignore"), "");
    assert.equal(extensionOf("x/archive.tar.GZ"), "gz");
  });
});

describe("preview url", () => {
  it("names the project, the file and its version", () => {
    const url = previewUrl("http://keel-file.localhost/", "C:\\code\\my app", "img/a b#1.png", 42);
    const parsed = new URL(url);
    assert.equal(parsed.origin, "http://keel-file.localhost");
    assert.equal(parsed.searchParams.get("root"), "C:\\code\\my app");
    assert.equal(parsed.searchParams.get("rel"), "img/a b#1.png");
    assert.equal(parsed.searchParams.get("v"), "42");
  });
});

describe("hex rows", () => {
  it("lays out sixteen bytes a row with offsets and ASCII", () => {
    const bytes = new Uint8Array([...Array(16).keys()].map((n) => n + 0x41));
    const [row] = hexRows(bytes, 0x20);
    assert.equal(row?.offset, "00000020");
    assert.equal(row?.hex, "41 42 43 44 45 46 47 48  49 4a 4b 4c 4d 4e 4f 50");
    assert.equal(row?.ascii, "ABCDEFGHIJKLMNOP");
  });

  it("pads a short last row so columns stay aligned", () => {
    const rows = hexRows(new Uint8Array([0x00, 0x7f, 0x20, 0x41, 0xff]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.hex.length, hexRows(new Uint8Array(16))[0]?.hex.length);
    assert.equal(rows[0]?.ascii, "·· A·");
  });
});

describe("format bytes", () => {
  it("picks a sensible unit", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
    assert.equal(formatBytes(3 * 1024 * 1024 * 1024), "3.00 GB");
  });
});
