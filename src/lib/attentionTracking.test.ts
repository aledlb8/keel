import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { startAttentionTracking, useKeel } from "../state/store.ts";
import type { AgentScreen } from "./agentActivity.ts";
import { forgetPaneAlerts, shouldAlert } from "./agentNotify.ts";
import { applySession } from "./launch.ts";
import type { AgentEventKind } from "./agentEvents.ts";
import { ChimePlayer } from "./chime.ts";
import type { Project } from "./types.ts";

const state = useKeel.getState;
let now = 0;
let focused = false;
let activeTerminal: string | null = "agent";
let chimes = 0;
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

function hook(kind: AgentEventKind, sequence: number, sessionId = "chat-a", id = "agent", generation = 0) {
  state().noteAgentEvent(id, generation, { agentId: "claude", sessionId, kind, sequence });
}

it("captures the next CLI's first hook after returning to the shell", () => {
  hook("session", 1);
  state().releaseAgent("agent", 0);
  hook("session", 2, "next-chat");
  assert.equal(state().projects[0]!.decks[0]!.panes.agent!.sessionId, "next-chat");
  hook("working", 3, "next-chat");
  hook("completed", 4, "next-chat");
  tick();
  assert.equal(state().status.agent, "done");
});

it("rejects stale provider changes before they mutate the pane or reset ordering", () => {
  hook("session", 10);
  state().noteAgentEvent("agent", 0, {
    agentId: "grok", sessionId: "stale-chat", kind: "session", sequence: 9,
  });
  const pane = state().projects[0]!.decks[0]!.panes.agent!;
  assert.equal(pane.agentId, "claude");
  assert.equal(pane.sessionId, "chat-a");
});

it("late startup identity cannot erase work already in progress", () => {
  hook("working", 1);
  hook("session", 2);
  tick();
  assert.equal(state().status.agent, "working");
  hook("completed", 3);
  tick();
  assert.equal(state().status.agent, "done");
});

it("an identity refresh cannot acknowledge an unseen completion", () => {
  hook("working", 1);
  hook("completed", 2);
  hook("session", 3);
  hook("identity", 4);
  tick();
  assert.equal(state().status.agent, "done");
});

it("a delayed watcher start cannot mutate identity after the shell has exited", () => {
  hook("session", 1);
  state().notePaneExit("agent", 0);
  state().noteRunningAgent("agent", 0, "grok", "late-process");
  const pane = state().projects[0]!.decks[0]!.panes.agent!;
  assert.equal(pane.agentId, "claude");
  assert.equal(pane.sessionId, "chat-a");
  assert.equal(state().exited.agent, true);
});

it("acknowledges a completion even before the attention timer consumes it", () => {
  hook("working", 1);
  hook("completed", 2);
  state().noteActivity("agent", "input", "next prompt");
  tick();
  assert.equal(state().status.agent, "idle");
  assert.equal(chimes, 0);
});

it("terminal failure remains terminal when a winding-down tool reports progress", () => {
  hook("working", 1);
  hook("failed", 2);
  hook("progress", 3);
  hook("completed", 4);
  tick();
  assert.equal(state().status.agent, "idle");
});

it("binds exact concurrent pane identities without reading recent sessions", () => {
  const p = project();
  p.decks[0]!.panes.other = { ...p.decks[0]!.panes.agent!, id: "other" };
  useKeel.setState({ projects: [p] });
  state().noteActivity("other", "spawn");
  let probes = 0;
  mockIPC((command) => { if (command === "session_recent") probes++; return null; });
  hook("session", 1, "chat-b", "other");
  hook("session", 1);
  const panes = state().projects[0]!.decks[0]!.panes;
  assert.equal(panes.agent!.sessionId, "chat-a");
  assert.equal(panes.other!.sessionId, "chat-b");
  assert.equal(panes.agent!.sessionReady, true);
  assert.equal(applySession("claude", { resume: "--resume {id}" }, panes.agent!), 'claude --resume "chat-a"');
  tick(60_000);
  assert.equal(probes, 0);
  assert.equal(state().status.agent, "idle");
});

it("finishes a hook turn without local Enter, a spinner, or visible terminal changes", () => {
  hook("session", 1);
  hook("working", 2);
  hook("completed", 3);
  hook("completed", 4); // Duplicate Stop before the attention timer must not lose completion.
  tick();
  assert.equal(state().status.agent, "done");
  const doneAt = state().doneAt.agent;
  hook("completed", 4);
  render(busy);
  tick(5_000);
  assert.equal(state().status.agent, "done");
  assert.equal(state().doneAt.agent, doneAt);
});

it("restored sessions and unmatched Stop never announce completed work", () => {
  hook("session", 1);
  hook("completed", 2);
  render(busy);
  render(ready);
  tick(5_000);
  assert.equal(state().status.agent, "idle");
});

it("waiting and long tool turns cannot finish from a ready-looking screen", () => {
  hook("working", 1);
  hook("waiting", 2);
  render(ready);
  tick(60_000);
  assert.equal(state().status.agent, "waiting");
  hook("progress", 3);
  hook("completed", 4);
  tick();
  assert.equal(state().status.agent, "done");
});

it("compaction identity refresh preserves a running turn and leaves an idle session idle", () => {
  hook("session", 1);
  hook("identity", 2);
  tick();
  assert.equal(state().status.agent, "idle");
  hook("working", 3);
  hook("identity", 4);
  tick();
  assert.equal(state().status.agent, "working");
  hook("completed", 5);
  tick();
  assert.equal(state().status.agent, "done");
});

it("rejects old-generation and out-of-order events before binding their IDs", () => {
  hook("session", 2, "correct-chat");
  hook("session", 1, "wrong-chat");
  assert.equal(state().projects[0]!.decks[0]!.panes.agent!.sessionId, "correct-chat");
  state().restartPane("agent");
  state().noteActivity("agent", "spawn");
  hook("working", 3, "old-process-chat");
  hook("session", 1, "correct-chat", "agent", 1);
  tick();
  assert.equal(state().projects[0]!.decks[0]!.panes.agent!.sessionId, "correct-chat");
  assert.equal(state().status.agent, "idle");
});

for (const end of ["cancelled", "failed", "ended"] as const) {
  it(`does not announce success for a ${end} hook turn`, () => {
    hook("working", 1);
    hook(end, 2);
    tick();
    assert.equal(state().status.agent, "idle");
    assert.deepEqual(state().doneAt, {});
  });
}

it("suppresses completion after Ctrl+C even if a winding-down tool emits progress", () => {
  hook("working", 1);
  state().noteActivity("agent", "input", "\x03");
  hook("progress", 2);
  hook("completed", 3);
  tick();
  assert.equal(state().status.agent, "idle");
});

beforeEach(() => {
  forgetPaneAlerts("agent");
  now = 0;
  focused = false;
  activeTerminal = "agent";
  chimes = 0;
  mock.method(ChimePlayer.prototype, "play", async () => { chimes++; });
  Object.assign(globalThis, { window: {}, document: {
    hasFocus: () => focused,
    activeElement: { closest: () => activeTerminal ? { getAttribute: () => activeTerminal } : null },
  } });
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
  assert.equal(chimes, 0);
});

for (const elsewhere of ["terminal", "deck", "project", "workspace", "editor", "dialog", "background", "muted"] as const) {
  it(`chimes once when the agent finishes while focus is elsewhere: ${elsewhere}`, () => {
    focused = true;
    startTurn();
    const current = structuredClone(state().projects[0]!);
    const other = project("other", null);
    other.id = "other-project";
    if (elsewhere === "terminal") {
      current.decks[0]!.panes.other = other.decks[0]!.panes.other!;
      current.decks[0]!.focused = "other";
      useKeel.setState({ projects: [current] });
      activeTerminal = "other";
    } else if (elsewhere === "deck") {
      other.decks[0]!.id = "other-deck";
      current.decks.push(other.decks[0]!);
      current.activeDeckId = "other-deck";
      useKeel.setState({ projects: [current] });
      activeTerminal = "other";
    } else if (elsewhere === "project" || elsewhere === "workspace") {
      useKeel.setState({ projects: [current, other], activeProjectId: other.id });
      activeTerminal = "other";
      if (elsewhere === "workspace") useKeel.setState({ workspaces: [
        { id: "first", name: "First", collapsed: false, projectIds: [current.id], activeProjectId: current.id },
        { id: "second", name: "Second", collapsed: false, projectIds: [other.id], activeProjectId: other.id },
      ] });
    } else if (elsewhere === "background") {
      focused = false;
    } else {
      // An editor or portal dialog owns DOM focus while this pane remains selected.
      activeTerminal = null;
      if (elsewhere === "muted") state().setPaneMuted("agent", true);
    }
    render(ready);
    tick(2_450);
    assert.equal(state().status.agent, "done");
    assert.equal(chimes, 1);
    tick(5_000);
    assert.equal(chimes, 1);
  });
}

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
  assert.equal(state().projects[0]?.decks[0]?.panes.agent?.resumeAgent, true);
  assert.equal(state().exited.agent, undefined);
  assert.equal(state().status.agent, "idle");
  assert.deepEqual(state().doneAt, {});
});

it("an old ready snapshot cannot finish a new running generation", () => {
  state().restartPane("agent");
  state().noteActivity("agent", "spawn");
  render(ready, "agent", 1);
  state().noteActivity("agent", "input", "\r");
  render(busy, "agent", 1);
  tick();
  state().noteScreen("agent", 0, ready);
  tick(60_000);
  assert.equal(state().status.agent, "working");
});

it("a shell that becomes claude tracks the next turn, and quitting clears it", () => {
  useKeel.setState({
    agents: [{
      id: "claude", name: "Claude Code", command: "claude", short: "CC", accent: "",
      bins: ["claude"], paths: [], path: "claude", installed: true, builtin: true,
    }],
    projects: [project("shell", null)],
  });
  state().noteRunningAgent("shell", 0, "claude");
  assert.equal(state().projects[0]?.decks[0]?.panes.shell?.agentId, "claude");
  assert.equal(state().projects[0]?.decks[0]?.panes.shell?.resumeAgent, true);
  render(ready, "shell");
  state().noteActivity("shell", "input", "\r");
  render(busy, "shell");
  tick();
  assert.equal(state().status.shell, "working");
  state().noteRunningAgent("shell", 0, null);
  assert.equal(state().projects[0]?.decks[0]?.panes.shell?.agentId, null);
  tick(10_000);
  assert.equal(state().status.shell, "idle");
  assert.deepEqual(state().doneAt, {});
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

it("finishes a Codex turn with the model/directory footer", () => {
  useKeel.setState({ projects: [project("agent", "codex")] });
  render({ lines: ["› ", "gpt-6-astra high · ~\\code"], cursorLine: 0 });
  state().noteActivity("agent", "input", "\r");
  render({ lines: ["• Working (18s • esc to interrupt)", "› ", "gpt-6-astra high · ~\\code"], cursorLine: 1 });
  tick();
  assert.equal(state().status.agent, "working");
  render({ lines: ["Finished the changes.", "› ", "gpt-6-astra high · ~\\code"], cursorLine: 1 });
  tick(2_450);
  assert.equal(state().status.agent, "done");
});

function alertFor(paneId: string, kind: "done" | "exited") {
  const project = state().projects[0];
  const pane = project?.decks[0]?.panes[paneId];
  assert.ok(project && pane);
  return {
    kind,
    paneId: pane.id,
    title: pane.title,
    projectName: project.name,
    muted: pane.muted === true,
    windowFocused: focused,
    paneFocused: focused && activeTerminal === paneId,
    restoring: state().restoreStatus === "restoring",
    silentPane: Boolean(pane.editor) || !pane.agentId,
  };
}

it("a finished unwatched agent is eligible for an OS toast", () => {
  startTurn();
  render(ready);
  tick(2_450);
  assert.equal(state().status.agent, "done");
  assert.equal(focused, false);
  assert.deepEqual(shouldAlert(alertFor("agent", "done")), { notify: true, chime: true });
});

it("an agent process death is eligible for an OS toast, and mute strips from the pane", () => {
  state().notePaneExit("agent");
  assert.equal(state().exited.agent, true);
  assert.deepEqual(shouldAlert(alertFor("agent", "exited")), { notify: true, chime: true });
  state().setPaneMuted("agent", true);
  assert.equal(state().projects[0]?.decks[0]?.panes.agent?.muted, true);
  assert.deepEqual(shouldAlert(alertFor("agent", "exited")), { notify: false, chime: true });
  state().setPaneMuted("agent", false);
  assert.equal("muted" in (state().projects[0]?.decks[0]?.panes.agent ?? {}), false);
});

function captureNotifications(): string[] {
  const notifications: string[] = [];
  Object.assign(window, { Notification: class {
    static permission = "granted";
    constructor(title: string) { notifications.push(title); }
  } });
  return notifications;
}

it("notifies when the agent exits while its shell stays alive, only once", async () => {
  const notifications = captureNotifications();
  startTurn();
  state().releaseAgent("agent", 0);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(notifications, ["Agent exited"]);
  assert.equal(state().exited.agent, undefined);
  tick(3_000);
  state().releaseAgent("agent", 0);
  state().notePaneExit("agent", 0);
  await Promise.resolve();
  assert.deepEqual(notifications, ["Agent exited"]);
});

for (const suppressor of ["muted", "focused", "restoring", "closing", "hostLost"] as const) {
  it(`suppresses agent exit alerts while ${suppressor}`, async () => {
    const notifications = captureNotifications();
    if (suppressor === "muted") state().setPaneMuted("agent", true);
    if (suppressor === "focused") focused = true;
    if (suppressor === "restoring") useKeel.setState({ restoreStatus: "restoring" });
    if (suppressor === "closing") useKeel.setState({ closing: { agent: true } });
    if (suppressor === "hostLost") useKeel.setState({ hostLost: true });
    state().releaseAgent("agent", 0);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(notifications, []);
    assert.equal(chimes, suppressor === "muted" ? 1 : 0);
  });
}
