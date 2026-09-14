import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Agent, AgentAccount } from "./types.ts";
import {
  buildUsageQueries,
  formatPercent,
  formatReset,
  profileLabel,
  tightestWindow,
  usageQueryKey,
  type UsageWindow,
} from "./usage.ts";

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
