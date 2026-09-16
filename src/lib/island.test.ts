import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  lookingAt,
  matchScore,
  rankBy,
  sinceLabel,
  systemMoment,
  waitingPanes,
  workingPanes,
} from "./island.ts";
import type { Project } from "./types.ts";

function pane(id: string, agentId: string | null = "claude") {
  return { id, agentId, accountId: null, title: `Pane ${id}`, cwd: null };
}

function project(
  id: string,
  decks: { id: string; panes: string[]; focused?: string }[],
  activeDeckId = decks[0]?.id ?? "",
): Project {
  return {
    id,
    name: `Project ${id}`,
    path: `/code/${id}`,
    activeDeckId,
    collapsed: false,
    decks: decks.map((deck) => ({
      id: deck.id,
      name: `Deck ${deck.id}`,
      tree: null,
      focused: deck.focused ?? null,
      zoomed: null,
      panes: Object.fromEntries(deck.panes.map((paneId) => [paneId, pane(paneId)])),
    })),
  } as unknown as Project;
}

const projects = [
  project("p1", [
    { id: "d1", panes: ["a", "b"], focused: "a" },
    { id: "d2", panes: ["c"] },
  ]),
  project("p2", [{ id: "d3", panes: ["d"] }]),
];

describe("lookingAt", () => {
  it("is the focused pane of the active deck", () => {
    assert.equal(lookingAt(projects, "p1"), "a");
  });

  it("is nothing without an active project or a focused pane", () => {
    assert.equal(lookingAt(projects, null), null);
    assert.equal(lookingAt(projects, "p2"), null);
  });
});

describe("waitingPanes", () => {
  const status = { a: "done", b: "done", c: "working", d: "done" } as const;
  const doneAt = { a: 10, b: 30, d: 20 };

  it("lists finished agents, longest-waiting first", () => {
    const waiting = waitingPanes(projects, status, doneAt, null);
    assert.deepEqual(
      waiting.map((entry) => entry.paneId),
      ["a", "d", "b"],
    );
    assert.equal(waiting[1]?.projectName, "Project p2");
  });

  it("leaves out the pane you are looking at", () => {
    const waiting = waitingPanes(projects, status, doneAt, "a");
    assert.deepEqual(
      waiting.map((entry) => entry.paneId),
      ["d", "b"],
    );
  });
});

describe("workingPanes", () => {
  it("lists agents still working", () => {
    assert.deepEqual(
      workingPanes(projects, { a: "idle", c: "working" }).map((ref) => ref.paneId),
      ["c"],
    );
  });
});

describe("systemMoment", () => {
  const calm = {
    hostLost: false,
    restoring: false,
    restoreLeft: 0,
    restoreTotal: 0,
    vpnConnecting: false,
  };

  it("is nothing when all is well", () => {
    assert.equal(systemMoment(calm), null);
  });

  it("puts a lost host above everything", () => {
    assert.deepEqual(
      systemMoment({ ...calm, hostLost: true, restoring: true, vpnConnecting: true }),
      { kind: "host-lost" },
    );
  });

  it("counts restore progress", () => {
    assert.deepEqual(
      systemMoment({ ...calm, restoring: true, restoreLeft: 5, restoreTotal: 9, vpnConnecting: true }),
      { kind: "restoring", done: 4, total: 9 },
    );
  });

  it("falls back to the tunnel coming up", () => {
    assert.deepEqual(systemMoment({ ...calm, vpnConnecting: true }), {
      kind: "vpn-connecting",
    });
  });
});

describe("matchScore", () => {
  it("matches letters in order", () => {
    assert.notEqual(matchScore("Claude Code", "cc"), null);
    assert.equal(matchScore("Codex", "xyz"), null);
  });

  it("prefers a substring at a word start", () => {
    const start = matchScore("Claude Code", "code")!;
    const middle = matchScore("opencode", "code")!;
    const scattered = matchScore("Claude Code", "cde")!;
    assert.ok(start > middle);
    assert.ok(middle > scattered);
  });

  it("ignores case and surrounding space", () => {
    assert.equal(matchScore("Keel", "  KEEL "), matchScore("Keel", "keel"));
  });
});

describe("rankBy", () => {
  const items = ["opencode", "Claude Code", "Codex", "Gemini"];

  it("keeps every item for an empty query", () => {
    assert.deepEqual(rankBy(items, " ", (item) => [item]), items);
  });

  it("drops misses and puts the best match first", () => {
    assert.deepEqual(rankBy(items, "code", (item) => [item]), [
      "Codex",
      "Claude Code",
      "opencode",
    ]);
  });
});

describe("sinceLabel", () => {
  it("reads as a short duration", () => {
    assert.equal(sinceLabel(0, 10_000), "just now");
    assert.equal(sinceLabel(0, 4 * 60_000), "4m ago");
    assert.equal(sinceLabel(0, 3 * 3_600_000), "3h ago");
    assert.equal(sinceLabel(0, 50 * 3_600_000), "2d ago");
  });
});
