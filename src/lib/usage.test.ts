import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Agent, AgentAccount } from "./types.ts";
import {
  aheadOfPace,
  buildUsageQueries,
  formatPercent,
  formatReset,
  isReady,
  profileLabel,
  retainUsage,
  tightestWindow,
  usageKey,
  usageLevel,
  usageQueryKey,
  windowElapsed,
  windowName,
  windowShortName,
  type AgentUsage,
  type KeptUsage,
  type UsageWindow,
} from "./usage.ts";

function reading(
  agentId: string,
  accountId: string | null,
  extra: Partial<AgentUsage> = {},
): AgentUsage {
  return {
    agentId,
    accountId,
    short: agentId.slice(0, 2).toUpperCase(),
    name: agentId,
    accent: "#fff",
    plan: null,
    windows: [window(40, "5h")],
    status: "ok",
    error: null,
    updatedAt: 0,
    ...extra,
  };
}

describe("isReady", () => {
  it("wants an answer with at least one window", () => {
    assert.equal(isReady(reading("claude", null)), true);
    assert.equal(isReady(reading("claude", null, { windows: [] })), false);
    assert.equal(
      isReady(reading("claude", null, { status: "error", error: "401" })),
      false,
    );
  });
});

describe("retainUsage", () => {
  const live = new Set([usageKey("claude", null), usageKey("codex", "cx")]);

  it("shows only logins that answered with numbers", () => {
    const kept = retainUsage(
      new Map(),
      [
        reading("claude", null),
        reading("codex", "cx", { status: "error", windows: [] }),
      ],
      1_000,
      live,
    );
    assert.deepEqual([...kept.keys()], ["claude:"]);
  });

  it("keeps the last good reading through a failed poll", () => {
    const first = retainUsage(new Map(), [reading("claude", null)], 1_000, live);
    const after = retainUsage(
      first,
      [reading("claude", null, { status: "error", windows: [] })],
      2_000,
      live,
    );
    assert.equal(after.get("claude:")?.at, 1_000);
  });

  it("lets a reading go once it is stale, or no longer asked about", () => {
    const kept = new Map<string, KeptUsage>([
      ["claude:", { usage: reading("claude", null), at: 0 }],
      ["gemini:", { usage: reading("gemini", null), at: 5_000 }],
    ]);
    assert.deepEqual([...retainUsage(kept, [], 5_000, live, 1_000).keys()], []);
    assert.deepEqual([...retainUsage(kept, [], 500, live, 1_000).keys()], ["claude:"]);
  });
});

describe("windowElapsed", () => {
  const now = 1_000_000_000;
  const hours = (count: number) => count * 3_600_000;

  it("is unknown without a reset time", () => {
    assert.equal(windowElapsed(window(10, "5h"), now), null);
  });

  it("measures how far through the window we are", () => {
    const half = { ...window(10, "5h"), resetsAt: now + hours(2.5) };
    assert.equal(windowElapsed(half, now), 0.5);
    assert.equal(windowElapsed({ ...half, resetsAt: now - 1 }, now), 1);
    assert.equal(windowElapsed({ ...half, resetsAt: now + hours(9) }, now), 0);
  });

  it("calls it ahead of pace only when usage clearly outruns time", () => {
    const early = { ...window(60, "5h"), resetsAt: now + hours(4) };
    assert.equal(aheadOfPace(early, now), true);
    assert.equal(aheadOfPace({ ...early, usedPercent: 20 }, now), false);
    assert.equal(aheadOfPace({ ...early, resetsAt: now + hours(1) }, now), false);
  });
});

function window(used: number, label: string): UsageWindow {
  return { usedPercent: used, windowMinutes: 300, resetsAt: null, label };
}

describe("formatReset", () => {
  const now = Date.parse("2026-09-14T12:00:00Z");

  it("returns empty when the reset is unknown", () => {
    assert.equal(formatReset(null, now), "");
  });

  it("says now once the window has elapsed", () => {
    assert.equal(formatReset(now - 1_000, now), "now");
  });

  it("uses minutes under an hour", () => {
    assert.equal(formatReset(now + 5 * 60_000, now), "5m");
  });

  it("uses hours and leftover minutes", () => {
    assert.equal(formatReset(now + (3 * 60 + 12) * 60_000, now), "3h 12m");
  });

  it("uses days past 24 hours", () => {
    assert.equal(formatReset(now + (2 * 24 + 4) * 60 * 60_000, now), "2d 4h");
  });
});

describe("formatPercent", () => {
  it("rounds and clamps", () => {
    assert.equal(formatPercent(32.4), "32%");
    assert.equal(formatPercent(150), "100%");
    assert.equal(formatPercent(-4), "0%");
  });
});

describe("usageLevel", () => {
  it("bands by used percent", () => {
    assert.equal(usageLevel(10), "ok");
    assert.equal(usageLevel(75), "warn");
    assert.equal(usageLevel(90), "hot");
  });
});

describe("windowName", () => {
  it("spells out known tags and passes model buckets through", () => {
    assert.equal(windowName("5h"), "5-hour");
    assert.equal(windowName("wk"), "Weekly");
    assert.equal(windowName("Opus"), "Opus");
  });
});

describe("windowShortName", () => {
  it("shortens known windows and clips model buckets", () => {
    assert.equal(windowShortName("5h"), "5h");
    assert.equal(windowShortName("wk"), "Wk");
    assert.equal(windowShortName("Sonnet"), "Sonn");
  });
});

describe("tightestWindow", () => {
  it("returns null when there are no windows", () => {
    assert.equal(tightestWindow([]), null);
  });

  it("picks the highest used percent", () => {
    const picked = tightestWindow([
      window(12, "5h"),
      window(81, "wk"),
      window(40, "mo"),
    ]);
    assert.equal(picked?.label, "wk");
    assert.equal(picked?.usedPercent, 81);
  });
});

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    command: id,
    short: id.slice(0, 2).toUpperCase(),
    accent: "#fff",
    bins: [id],
    paths: [],
    path: null,
    installed: true,
    builtin: true,
    accountEnv: extra.accountEnv,
    hidden: extra.hidden,
    ...extra,
  };
}

describe("buildUsageQueries", () => {
  it("asks for the default login of each usage-capable agent", () => {
    const query = buildUsageQueries(
      [agent("claude", { accountEnv: "CLAUDE_CONFIG_DIR" }), agent("aider")],
      [],
    );
    assert.deepEqual(
      query.map((item) => `${item.id}:${item.accountId ?? ""}`),
      ["claude:"],
    );
  });

  it("adds a query for every named profile of an isolating agent", () => {
    const accounts: AgentAccount[] = [
      { id: "work", agentId: "claude", name: "Work" },
      { id: "home", agentId: "claude", name: "Home" },
      { id: "cx", agentId: "codex", name: "Plus" },
    ];
    const query = buildUsageQueries(
      [
        agent("claude", { accountEnv: "CLAUDE_CONFIG_DIR" }),
        agent("codex", { accountEnv: "CODEX_HOME" }),
      ],
      accounts,
    );
    assert.deepEqual(
      query.map((item) => `${item.id}:${item.accountId ?? ""}`),
      ["claude:", "claude:work", "claude:home", "codex:", "codex:cx"],
    );
  });

  it("does not query named profiles when the agent cannot isolate them", () => {
    const query = buildUsageQueries(
      [agent("gemini")],
      [{ id: "g1", agentId: "gemini", name: "Work" }],
    );
    assert.deepEqual(
      query.map((item) => `${item.id}:${item.accountId ?? ""}`),
      ["gemini:"],
    );
  });

  it("skips hidden agents", () => {
    const query = buildUsageQueries(
      [agent("claude", { accountEnv: "CLAUDE_CONFIG_DIR", hidden: true })],
      [{ id: "work", agentId: "claude", name: "Work" }],
    );
    assert.equal(query.length, 0);
  });
});

describe("profileLabel", () => {
  const accounts: AgentAccount[] = [
    { id: "work", agentId: "claude", name: "Work" },
  ];

  it("calls the default slot Default", () => {
    assert.equal(profileLabel(null, accounts), "Default");
  });

  it("uses the profile's given name", () => {
    assert.equal(profileLabel("work", accounts), "Work");
  });
});

describe("usageQueryKey", () => {
  it("is stable regardless of query order", () => {
    const a = buildUsageQueries(
      [agent("claude", { accountEnv: "CLAUDE_CONFIG_DIR" })],
      [{ id: "work", agentId: "claude", name: "Work" }],
    );
    const b = [...a].reverse();
    assert.equal(usageQueryKey(a), usageQueryKey(b));
  });
});
