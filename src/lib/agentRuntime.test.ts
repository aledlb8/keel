import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentRuntime } from "./agentRuntime.ts";
import type { AgentEvent, AgentEventKind } from "./agentEvents.ts";

function event(kind: AgentEventKind, sequence: number, extra: Partial<AgentEvent> = {}): AgentEvent {
  return { agentId: "codex", sessionId: "chat", processId: "100:1000", turnId: "turn-a", kind, sequence, ...extra };
}

it("a late Stop or Interrupt for an earlier turn cannot end the current turn", () => {
  for (const stale of ["completed", "cancelled", "failed", "progress"] as const) {
    const runtime = new AgentRuntime();
    runtime.event(event("working", 1));
    runtime.event(event("working", 2, { turnId: "turn-b" }));
    assert.equal(runtime.event(event(stale, 3)), false);
    assert.equal(runtime.status("working", 100, false), "working");
    runtime.event(event("completed", 4, { turnId: "turn-b" }));
    assert.equal(runtime.status("working", 200, false), "done");
  }
});

it("rejected and malformed events cannot establish protocol authority", () => {
  for (const extra of [{ sequence: NaN }, { sequence: 0 }, { sequence: 1.5 },
    { sessionId: "bad id" }, { agentId: "unsupported" }]) {
    const runtime = new AgentRuntime();
    assert.equal(runtime.event(event("session", 1, extra)), false);
    assert.equal(runtime.usesProtocol, false);
  }
});

it("retired process events cannot reclaim ownership, even with newer delivery sequences", () => {
  const runtime = new AgentRuntime();
  runtime.event(event("working", 1));
  runtime.event(event("working", 2, { processId: "200:2000", sessionId: "new-chat" }));
  assert.equal(runtime.endProcess("100:1000"), false);
  assert.equal(runtime.observeProcess("codex", "100:1000"), false);
  assert.equal(runtime.event(event("session", 3)), false);
  assert.equal(runtime.status("idle", 0, false), "working");
});

it("protocol interruption uses fresh screen evidence without inventing completion", () => {
  const runtime = new AgentRuntime();
  runtime.event(event("working", 1));
  runtime.input("\x03", 0);
  assert.equal(runtime.needsScreen, true);
  assert.equal(runtime.status("working", 1, false), "working");
  assert.equal(runtime.status("working", 60_000, false), "working");
  runtime.output(10);
  runtime.screen("busy", 10, "tool winding down");
  assert.equal(runtime.status("working", 60_000, false), "working");
  runtime.output(60_100);
  runtime.screen("ready", 60_100, "prompt");
  assert.equal(runtime.status("working", 61_000, false), "working");
  assert.equal(runtime.status("working", 62_200, false), "idle");
  runtime.event(event("completed", 2));
  assert.equal(runtime.status("idle", 62_300, false), "idle");
  assert.equal(runtime.needsScreen, false);
});

it("pasting an escape or newline is not an interruption or a turn", () => {
  const runtime = new AgentRuntime();
  runtime.event(event("working", 1));
  runtime.input("\x1b[200~", 0);
  runtime.input("\r", 1);
  runtime.input("\x03", 2);
  runtime.input("\x1b[201~", 3);
  runtime.event(event("completed", 2));
  assert.equal(runtime.status("working", 5, false), "done");
});

it("every provider tolerates watcher-start arriving anywhere in a fast hook turn", () => {
  for (const agentId of ["claude", "codex", "grok", "opencode"]) {
    for (let position = 0; position <= 3; position++) {
      const runtime = new AgentRuntime();
      const trace = ["session", "working", "completed"] as const;
      for (let index = 0; index <= trace.length; index++) {
        if (index === position) runtime.observeProcess(agentId, "100:1000");
        if (index < trace.length) runtime.event(event(trace[index]!, index + 1, { agentId }));
      }
      assert.equal(runtime.status("idle", 0, false), "done", `${agentId}, watcher at ${position}`);
      assert.equal(runtime.status("idle", 1, false), "idle");
    }
  }
});
