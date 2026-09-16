import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { startAttentionTracking, useKeel } from "../state/store.ts";
import type { AgentScreen } from "./agentActivity.ts";
import type { Project } from "./types.ts";

const state = useKeel.getState;
let now = 0;
let focused = false;
let stop: () => void;

function project(id = "agent", agentId: string | null = "claude"): Project {
  return {
    id: "project", name: "Project", path: "/code", collapsed: false, activeDeckId: "deck",
    decks: [{
      id: "deck", name: "Deck", tree: { kind: "pane", id }, focused: id, zoomed: null,
      panes: { [id]: { id, agentId, accountId: null, resumeAgent: agentId !== null,
        sessionId: null, sessionReady: false, title: "Agent", cwd: null } },
    }],
  };
}

const ready: AgentScreen = { lines: ["─────", "❯ ", "─────", "? for shortcuts"], cursorLine: 1 };
const busy: AgentScreen = { lines: ["✻ Thinking… (esc to interrupt)", ...ready.lines], cursorLine: 2 };

function tick(ms = 350) {
  now += ms;
  mock.timers.tick(ms);
}

function render(screen: AgentScreen, id = "agent", generation = 0) {
  state().noteOutput(id);
  state().noteScreen(id, generation, screen);
}

function startTurn() {
  render(ready);
  state().noteActivity("agent", "input", "hello");
  state().noteActivity("agent", "input", "\r");
  render(busy);
  tick();
  assert.equal(state().status.agent, "working");
}

beforeEach(() => {
  now = 0;
  focused = false;
  Object.assign(globalThis, { window: {}, document: { hasFocus: () => focused } });
  mockIPC(() => null);
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  mock.method(performance, "now", () => now);
  useKeel.setState({ ...useKeel.getInitialState(), projects: [project()], activeProjectId: "project" });
  state().noteActivity("agent", "spawn");
  stop = startAttentionTracking();
});

afterEach(() => {
  stop();
  mock.restoreAll();
  mock.timers.reset();
});

it("restoring a slow terminal does not produce an island completion", () => {
  useKeel.setState({ restoreStatus: "restoring", restorePanes: { agent: true }, restoreLeft: 1 });
  render(busy);
  tick(60_000);
  state().settleRestore("agent", true);
  render(ready);
  tick(10_000);
  assert.equal(state().status.agent, "idle");
  assert.deepEqual(state().doneAt, {});
});

it("records one completion timestamp and clears it on real input, not terminal reports", () => {
  startTurn();
  render(ready);
  tick(2_450);
  assert.equal(state().status.agent, "done");
  const doneAt = state().doneAt.agent;
  tick(2_450);
  assert.equal(state().doneAt.agent, doneAt);
  state().noteActivity("agent", "input", "\x1b[I");
  tick();
  assert.equal(state().status.agent, "done");
  state().noteActivity("agent", "input", "h");
  assert.equal(state().status.agent, "idle");
  assert.deepEqual(state().doneAt, {});
});

it("does not notify about the terminal the user is watching", () => {
  focused = true;
  startTurn();
  render(ready);
  tick(2_450);
  assert.equal(state().status.agent, "idle");
  assert.deepEqual(state().doneAt, {});
});

it("clears done before restart, ignores old generations, and ignores restore replay", () => {
  startTurn();
  render(ready);
  tick(2_450);
  state().restartPane("agent");
  assert.equal(state().status.agent, "idle");
  assert.deepEqual(state().doneAt, {});
  state().noteActivity("agent", "spawn");
  state().notePaneExit("agent", 0);
  state().releaseAgent("agent", 0);
  render(busy, "agent", 0);
  render(ready, "agent", 1);
  tick(60_000);
  assert.equal(state().projects[0].decks[0].panes.agent.resumeAgent, true);
  assert.equal(state().exited.agent, undefined);
  assert.equal(state().status.agent, "idle");
  assert.deepEqual(state().doneAt, {});
});

it("an old ready snapshot cannot finish a new running generation", () => {
  state().restartPane("agent");
  state().noteActivity("agent", "spawn");
  state().noteActivity("agent", "input", "\r");
  render(busy, "agent", 1);
  tick();
  state().noteScreen("agent", 0, ready);
  tick(60_000);
  assert.equal(state().status.agent, "working");
});

it("shell/agent exits clear activity without announcing completion", () => {
  startTurn();
  state().releaseAgent("agent", 0);
  tick(10_000);
  assert.equal(state().status.agent, "idle");
  assert.deepEqual(state().doneAt, {});
  state().notePaneExit("agent", 0);
  assert.equal(state().exited.agent, true);
});

it("host loss invalidates a pending completion until fresh screen evidence arrives", () => {
  startTurn();
  render(ready);
  state().noteHostLost();
  tick(10_000);
  assert.deepEqual(state().doneAt, {});
  state().clearHostLost();
  tick(10_000);
  assert.equal(state().status.agent, "working");
  assert.deepEqual(state().doneAt, {});
});

it("replaces stale pane keys even when the pane count has not changed", () => {
  useKeel.setState({ status: { removed: "idle" }, doneAt: { removed: 100 } });
  tick();
  assert.deepEqual(state().status, { agent: "idle" });
  assert.deepEqual(state().doneAt, {});
});

it("shells and closing panes cannot produce completion notifications", () => {
  useKeel.setState({ projects: [project("agent", null)] });
  state().noteActivity("agent", "input", "\r");
  render(busy);
  tick();
  assert.equal(state().status.agent, "idle");
  useKeel.setState({ projects: [project()] });
  startTurn();
  render(ready);
  useKeel.setState({ closing: { agent: true } });
  tick(10_000);
  assert.equal(state().status.agent, "idle");
  assert.deepEqual(state().doneAt, {});
});

it("late events for removed panes do not recreate status entries", () => {
  useKeel.setState({ projects: [] });
  state().notePaneExit("agent", 0);
  state().noteActivity("agent", "spawn");
  render(busy);
  tick(10_000);
  assert.deepEqual(state().status, {});
  assert.deepEqual(state().exited, {});
});

it("a session capture completed after restart cannot bind the old conversation", async () => {
  useKeel.setState({ agents: [{
    id: "claude", name: "Claude", command: "claude", short: "CC", accent: "",
    bins: [], paths: [], path: "claude", installed: true, builtin: true,
    session: { resume: "--resume {id}", store: "claude" },
  }] });
  let resolve!: (hits: { id: string; mtimeMs: number }[]) => void;
  const pending = new Promise<{ id: string; mtimeMs: number }[]>((yes) => { resolve = yes; });
  let reads = 0;
  mockIPC((command) => {
    if (command === "session_recent") { reads++; return pending; }
    return null;
  });
  const capture = state().captureSession("agent", 0);
  state().restartPane("agent");
  state().noteActivity("agent", "spawn");
  await state().captureSession("agent", 0);
  assert.equal(reads, 1);
  resolve([{ id: "old-chat", mtimeMs: Date.now() }]);
  await capture;
  assert.equal(state().projects[0].decks[0].panes.agent.sessionReady, false);
  assert.equal(state().projects[0].decks[0].panes.agent.sessionId, null);
});
