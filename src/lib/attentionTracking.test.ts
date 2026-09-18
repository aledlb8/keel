import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { startAttentionTracking, useKeel } from "../state/store.ts";
import type { AgentScreen } from "./agentActivity.ts";
import { forgetPaneAlerts, shouldAlert } from "./agentNotify.ts";
import { applySession } from "./launch.ts";
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
  assert.equal(state().projects[0]?.decks[0]?.panes.agent?.sessionReady, false);
  assert.equal(state().projects[0]?.decks[0]?.panes.agent?.sessionId, null);
});

it("binds an opencode conversation only from the submitted prompt, never at spawn", async () => {
  useKeel.setState({
    agents: [{
      id: "opencode", name: "opencode", command: "opencode", short: "OC", accent: "",
      bins: [], paths: [], path: "opencode", installed: true, builtin: true,
      session: { resume: "--session {id}", store: "opencode" },
    }],
    projects: [project("agent", "opencode")],
  });
  const probes: { store: string }[] = [];
  mockIPC((command, payload) => {
    if (command !== "session_recent") return null;
    probes.push((payload as { probe: { store: string } }).probe);
    return [{ id: "ses_new", mtimeMs: Date.now() }];
  });

  state().noteActivity("agent", "spawn");
  await state().captureSession("agent", 0);
  assert.equal(probes.length, 0, "a spawn-armed opencode capture has nothing to find");

  state().noteActivity("agent", "input", "restore the terminals");
  state().noteActivity("agent", "input", "\r");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(probes.length, 1);
  assert.equal(probes[0]?.store, "opencode");
  assert.equal(state().projects[0]?.decks[0]?.panes.agent?.sessionId, "ses_new");
  assert.equal(state().projects[0]?.decks[0]?.panes.agent?.sessionReady, true);
});

it("retries delayed OpenCode capture using the first submission even after another Enter", async () => {
  useKeel.setState({
    agents: [{
      id: "opencode", name: "opencode", command: "opencode", short: "OC", accent: "",
      bins: [], paths: [], path: "opencode", installed: true, builtin: true,
      session: { resume: "--session {id}", store: "opencode" },
    }],
    projects: [project("agent", "opencode")],
  });
  const created = Date.now() + 500;
  let reads = 0;
  mockIPC((command) => {
    if (command !== "session_recent") return null;
    reads++;
    return now < 6_000 ? [] : [
      { id: "older-chat", mtimeMs: created - 1_000 },
      { id: "ses_delayed", mtimeMs: created },
    ];
  });
  state().noteActivity("agent", "spawn");
  state().noteActivity("agent", "input", "\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads, 1);
  tick(3_000);
  state().noteActivity("agent", "input", "\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state().projects[0]?.decks[0]?.panes.agent?.sessionReady, false);
  tick(3_000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state().projects[0]?.decks[0]?.panes.agent?.sessionId, "ses_delayed");
  const pane = state().projects[0]!.decks[0]!.panes.agent!;
  assert.equal(applySession("opencode", state().agents[0]!.session, pane), 'opencode --session "ses_delayed"');
  const capturedReads = reads;
  tick(10_000);
  assert.equal(reads, capturedReads, "a bound chat stops polling");
});

it("stops idle OpenCode capture polling and discards a read completed after restart", async () => {
  useKeel.setState({
    agents: [{
      id: "opencode", name: "opencode", command: "opencode", short: "OC", accent: "",
      bins: [], paths: [], path: "opencode", installed: true, builtin: true,
      session: { resume: "--session {id}", store: "opencode" },
    }],
    projects: [project("agent", "opencode")],
  });
  let reads = 0;
  mockIPC((command) => {
    if (command === "session_recent") { reads++; return []; }
    return null;
  });
  state().noteActivity("agent", "spawn");
  await state().captureSession("agent", 0, Date.now());
  tick(61_000);
  assert.equal(reads, 1);
  let resolve!: (hits: { id: string; mtimeMs: number }[]) => void;
  mockIPC((command) => command === "session_recent"
    ? new Promise((done) => { resolve = done; }) : null);
  const pending = state().captureSession("agent", 0, Date.now());
  state().restartPane("agent");
  state().noteActivity("agent", "spawn");
  resolve([{ id: "ses_old_process", mtimeMs: Date.now() }]);
  await pending;
  assert.equal(state().projects[0]?.decks[0]?.panes.agent?.sessionId, null);
});

it("finishes a Codex turn with the model/directory footer", () => {
  useKeel.setState({ projects: [project("agent", "codex")] });
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
