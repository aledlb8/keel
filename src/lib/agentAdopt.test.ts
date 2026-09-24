import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";

import { forgetPaneAlerts } from "./agentNotify.ts";
import { applySession } from "./launch.ts";
import type { Agent, Pane, Project } from "./types.ts";
import { useKeel } from "../state/store.ts";

const state = useKeel.getState;

const claude: Agent = {
  id: "claude",
  name: "Claude Code",
  command: "claude",
  short: "CC",
  accent: "#d97757",
  accountEnv: "CLAUDE_CONFIG_DIR",
  bins: ["claude"],
  paths: [],
  path: "C:\\bin\\claude.exe",
  installed: true,
  builtin: true,
  session: { resume: "--resume {id}", store: "claude" },
};

const grok: Agent = {
  id: "grok",
  name: "Grok Build",
  command: "grok",
  short: "GR",
  accent: "#f5f5f5",
  accountEnv: "GROK_HOME",
  bins: ["grok"],
  paths: [],
  path: "C:\\bin\\grok.exe",
  installed: true,
  builtin: true,
  session: { resume: "--resume {id}", store: "grok" },
};

function pane(extra: Partial<Pane> & Pick<Pane, "id">): Pane {
  return {
    agentId: null,
    accountId: null,
    resumeAgent: false,
    sessionId: null,
    sessionReady: false,
    title: "Shell",
    cwd: "C:\\code\\keel",
    ...extra,
  };
}

function project(body: Pane): Project {
  return {
    id: "project",
    name: "Keel",
    path: "C:\\code\\keel",
    collapsed: false,
    activeDeckId: "deck",
    decks: [{
      id: "deck",
      name: "Deck",
      tree: { kind: "pane", id: body.id },
      focused: body.id,
      zoomed: null,
      panes: { [body.id]: body },
    }],
  };
}

function live(): Pane {
  const found = state().projects[0]?.decks[0]?.panes.term;
  assert.ok(found);
  return found;
}

beforeEach(() => {
  forgetPaneAlerts("term");
  Object.assign(globalThis, {
    window: {},
    document: {
      hasFocus: () => true,
      activeElement: {
        closest: () => ({ getAttribute: () => "term" }),
      },
    },
  });
  mockIPC(() => null);
  useKeel.setState({
    ...useKeel.getInitialState(),
    ready: true,
    restoreStatus: "idle",
    agents: [claude, grok],
    accounts: [{ id: "work", agentId: "claude", name: "Work", isDefault: true }],
    projects: [project(pane({ id: "term" }))],
    activeProjectId: "project",
    generations: { term: 3 },
  });
  state().noteShellSpawn("term", null, null);
});

afterEach(() => {
  mock.restoreAll();
});

it("a shell becomes the CLI that started in it, on the default login", async () => {
  const started = Date.now() - 5_000;
  mockIPC((command) => {
    if (command !== "session_recent") return null;
    return [{ id: "chat-1", mtimeMs: started + 2_000 }];
  });

  state().noteRunningAgent("term", 3, "claude", started);
  assert.equal(live().agentId, "claude");
  assert.equal(live().resumeAgent, true);
  // The process inherited the shell, not the default Work profile.
  assert.equal(live().accountId, null);
  assert.equal(live().title, "Claude Code");
  assert.equal(live().agentHome?.agentId, null);
  assert.equal(live().agentHome?.title, "Shell");
  assert.equal(live().sessionReady, false);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(live().sessionId, "chat-1");
  assert.equal(live().sessionReady, true);
  assert.equal(
    applySession(claude.command, claude.session, live()),
    'claude --resume "chat-1"',
  );
});

it("inherits the profile this shell was spawned with, and not another agent's", () => {
  mockIPC(() => []);
  state().noteShellSpawn("term", "claude", "work");
  state().noteRunningAgent("term", 3, "claude", Date.now());
  assert.equal(live().accountId, "work");
  state().noteRunningAgent("term", 3, null, 0);

  state().noteShellSpawn("term", "claude", "work");
  state().noteRunningAgent("term", 3, "grok", Date.now());
  assert.equal(live().agentId, "grok");
  assert.equal(live().accountId, null);
});

it("quitting that CLI returns the pane to a shell", async () => {
  mockIPC((command) => (
    command === "session_recent" ? [{ id: "chat-1", mtimeMs: Date.now() }] : null
  ));
  state().noteRunningAgent("term", 3, "claude", Date.now() - 1_000);
  await new Promise((resolve) => setTimeout(resolve, 0));

  state().noteRunningAgent("term", 3, null, 0);
  assert.equal(live().agentId, null);
  assert.equal(live().resumeAgent, false);
  assert.equal(live().accountId, null);
  assert.equal(live().sessionId, null);
  assert.equal(live().sessionReady, false);
  assert.equal(live().title, "Shell");
  assert.equal(live().agentHome, undefined);
});

it("starting a second CLI replaces the first and quitting still returns to the shell", async () => {
  mockIPC(() => null);
  state().noteRunningAgent("term", 3, "claude", Date.now() - 1_000);
  state().noteRunningAgent("term", 3, "grok", Date.now());
  assert.equal(live().agentId, "grok");
  assert.equal(live().title, "Grok Build");
  assert.equal(live().accountId, null);
  assert.equal(live().agentHome?.agentId, null);
  assert.equal(live().agentHome?.title, "Shell");

  state().noteRunningAgent("term", 3, null, 0);
  assert.equal(live().agentId, null);
  assert.equal(live().title, "Shell");
  assert.equal(live().resumeAgent, false);
});

it("keeps a name the user gave the shell", () => {
  useKeel.setState({
    projects: [project(pane({ id: "term", title: "deploy", titleLocked: true }))],
  });
  state().noteRunningAgent("term", 3, "claude", Date.now());
  assert.equal(live().title, "deploy");
  assert.equal(live().titleLocked, true);
  state().noteRunningAgent("term", 3, null, 0);
  assert.equal(live().title, "deploy");
  assert.equal(live().agentId, null);
});

it("ignores a stale generation and an editor pane", () => {
  state().noteRunningAgent("term", 2, "claude", Date.now());
  assert.equal(live().agentId, null);

  useKeel.setState({
    projects: [project(pane({
      id: "term",
      title: "Editor",
      editor: { tabs: [], active: null },
    }))],
  });
  state().noteRunningAgent("term", 3, "claude", Date.now());
  assert.equal(live().editor?.tabs.length, 0);
  assert.equal(live().agentId, null);
});

it("does not reset a launcher pane that is already that live agent", async () => {
  useKeel.setState({
    projects: [project(pane({
      id: "term",
      agentId: "claude",
      accountId: "work",
      resumeAgent: true,
      sessionId: "kept-chat",
      sessionReady: true,
      title: "fix auth",
    }))],
  });
  let reads = 0;
  mockIPC((command) => {
    if (command === "session_recent") reads += 1;
    return [{ id: "other-chat", mtimeMs: Date.now() }];
  });
  state().noteRunningAgent("term", 3, "claude", Date.now());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads, 0);
  assert.equal(live().sessionId, "kept-chat");
  assert.equal(live().accountId, "work");
  assert.equal(live().title, "fix auth");
  assert.equal(live().agentHome, undefined);
  assert.equal(live().resumeAgent, true);
});

it("rearms the same agent after it exited, and keeps its profile", async () => {
  const started = Date.now() - 2_000;
  mockIPC((command) => (
    command === "session_recent" ? [{ id: "chat-2", mtimeMs: started + 500 }] : null
  ));
  useKeel.setState({
    projects: [project(pane({
      id: "term",
      agentId: "claude",
      accountId: "work",
      resumeAgent: false,
      sessionId: "old-chat",
      sessionReady: true,
      title: "Claude Code",
    }))],
  });
  state().noteRunningAgent("term", 3, "claude", started);
  assert.equal(live().resumeAgent, true);
  assert.equal(live().accountId, "work");
  assert.equal(live().agentHome, undefined);
  assert.equal(live().sessionReady, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(live().sessionId, "chat-2");
  assert.equal(
    applySession(claude.command, claude.session, live()),
    'claude --resume "chat-2"',
  );
});

it("a different CLI inside an at-rest agent pane restores that agent when it exits", async () => {
  mockIPC(() => null);
  useKeel.setState({
    projects: [project(pane({
      id: "term",
      agentId: "claude",
      accountId: "work",
      resumeAgent: false,
      sessionId: "old-chat",
      sessionReady: true,
      title: "fix auth",
    }))],
  });
  state().noteRunningAgent("term", 3, "grok", Date.now());
  assert.equal(live().agentId, "grok");
  assert.equal(live().accountId, null);
  assert.equal(live().resumeAgent, true);
  assert.equal(live().agentHome?.agentId, "claude");
  assert.equal(live().agentHome?.accountId, "work");
  assert.equal(live().agentHome?.sessionId, "old-chat");
  // The work title is not the program name, so it stays while Grok runs.
  assert.equal(live().title, "fix auth");

  state().noteRunningAgent("term", 3, null, 0);
  assert.equal(live().agentId, "claude");
  assert.equal(live().accountId, "work");
  assert.equal(live().resumeAgent, false);
  assert.equal(live().sessionId, "old-chat");
  assert.equal(live().sessionReady, true);
  assert.equal(live().title, "fix auth");
  assert.equal(live().agentHome, undefined);
});
