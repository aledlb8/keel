import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { markFor } from "./agentMark.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("agent logos", () => {
  const logos = read("../components/agentLogos.tsx");

  it("ships the same logos on the website", () => {
    assert.equal(read("../../site/src/components/agentLogos.tsx"), logos);
  });

  it("has a logo for every built-in agent", () => {
    const drawn = new Set(
      [...logos.matchAll(/^ {2}(?:"([\w-]+)"|(\w+)): \{$/gm)].map((m) => m[1] ?? m[2]),
    );
    const catalogue = JSON.parse(read("../../src-tauri/agents.default.json")) as { id: string }[];
    for (const { id } of catalogue) assert.ok(drawn.has(id), `${id} has no logo`);
  });
});

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
