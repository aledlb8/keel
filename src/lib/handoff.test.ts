import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canHandOff, handoffTargets, handoffTitle, targetLabel } from "./handoff.ts";
import type { Agent, Pane } from "./types.ts";

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id === "claude" ? "Claude Code" : id,
    command: id,
    short: id.slice(0, 2).toUpperCase(),
    accent: "",
    bins: [],
    paths: [],
    path: `/bin/${id}`,
    installed: true,
    builtin: true,
    ...extra,
  };
}

function pane(extra: Partial<Pane> = {}): Pane {
  return {
    id: "p1",
    agentId: "claude",
    accountId: null,
    resumeAgent: true,
    sessionId: "11111111-2222-4333-8444-555555555555",
    sessionReady: true,
    title: "Fix login",
    cwd: null,
    ...extra,
  };
}

describe("canHandOff", () => {
  it("needs a linked conversation from an agent Keel can read", () => {
    assert.equal(canHandOff(pane()), true);
    for (const agentId of ["codex", "grok", "opencode"]) {
      assert.equal(canHandOff(pane({ agentId })), true, agentId);
    }
    assert.equal(canHandOff(pane({ agentId: "pi" })), false, "no hooks, no captured id");
    assert.equal(canHandOff(pane({ agentId: null })), false);
    assert.equal(canHandOff(pane({ sessionReady: false })), false);
    assert.equal(canHandOff(pane({ sessionId: null })), false);
    assert.equal(canHandOff(pane({ sessionId: "bad;id" })), false);
    assert.equal(canHandOff(pane({ editor: { tabs: [], active: null } })), false);
  });

  it("still works once the agent has exited, since the conversation is on disk", () => {
    assert.equal(canHandOff(pane({ resumeAgent: false })), true);
  });
});

describe("handoffTargets", () => {
  it("lists installed agents and offers a profile choice only where one exists", () => {
    const targets = handoffTargets(
      [
        agent("claude"),
        agent("codex", { accountEnv: "CODEX_HOME" }),
        agent("grok", { accountEnv: "GROK_HOME" }),
        agent("aider", { installed: false }),
        agent("goose", { hidden: true }),
      ],
      [
        { id: "work", agentId: "grok", name: "Work" },
        { id: "other", agentId: "claude", name: "Ignored, claude has no profiles" },
      ],
    );
    assert.deepEqual(
      targets.map((target) => target.agent.id),
      ["claude", "codex", "grok"],
    );
    assert.deepEqual(targets[0]?.profiles, []);
    assert.deepEqual(targets[1]?.profiles, []);
    assert.deepEqual(targets[2]?.profiles, [
      { accountId: null, label: "Default" },
      { accountId: "work", label: "Work" },
    ]);
  });
});

describe("labels", () => {
  it("says when an agent hands to a fresh chat of itself", () => {
    assert.equal(targetLabel(agent("claude"), "claude"), "Claude Code (new chat)");
    assert.equal(targetLabel(agent("codex"), "claude"), "codex");
  });

  it("names the new pane after the work and where it came from, within 60 characters", () => {
    assert.equal(handoffTitle("Fix login", "CC"), "Fix login · from CC");
    assert.equal(handoffTitle("  ", "CC"), "Handoff · from CC");
    const long = handoffTitle("x".repeat(100), "CC");
    assert.equal(long.length, 60);
    assert.ok(long.endsWith("… · from CC"));
  });
});
