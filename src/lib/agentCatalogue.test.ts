import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";

import { emptyDeck, useKeel } from "../state/store.ts";
import type { Agent, Pane, Project } from "./types.ts";

const state = useKeel.getState;

const custom: Agent = {
  id: "custom-1",
  name: "Custom",
  command: "custom",
  short: "CU",
  accent: "#6c9bf5",
  accountEnv: null,
  bins: [],
  paths: [],
  hidden: false,
  builtin: false,
  installed: true,
  path: "/bin/custom",
};

function pane(id: string, agentId: string | null): Pane {
  return {
    id,
    agentId,
    accountId: agentId ? "acct" : null,
    resumeAgent: agentId !== null,
    sessionId: agentId ? "sess" : null,
    sessionReady: agentId !== null,
    title: "Agent",
    cwd: null,
  };
}

beforeEach(() => {
  Object.assign(globalThis, { window: {} });
  const deck = emptyDeck("Deck 1");
  deck.tree = { kind: "pane", id: "p1" };
  deck.panes = { p1: pane("p1", "custom-1") };
  const project: Project = {
    id: "proj",
    name: "p",
    path: "C:/p",
    decks: [deck],
    activeDeckId: deck.id,
    collapsed: false,
  };
  useKeel.setState({
    ...useKeel.getInitialState(),
    ready: false,
    agents: [custom],
    accounts: [{ id: "acct", agentId: "custom-1", name: "Work" }],
    projects: [project],
    activeProjectId: "proj",
  });
});

it("unbinds panes and accounts when an agent leaves the catalogue", async () => {
  mockIPC((cmd) => (cmd === "agent_catalogue_save" ? [] : null));
  await state().saveAgents([]);
  const next = state().projects[0]?.decks[0]?.panes.p1;
  assert.equal(next?.agentId, null);
  assert.equal(next?.accountId, null);
  assert.equal(next?.resumeAgent, false);
  assert.equal(next?.sessionId, null);
  assert.equal(next?.sessionReady, false);
  assert.deepEqual(state().accounts, []);
});

it("leaves panes bound when their agent is still in the catalogue", async () => {
  mockIPC((cmd) => (cmd === "agent_catalogue_save" ? [custom] : null));
  await state().saveAgents([custom]);
  const next = state().projects[0]?.decks[0]?.panes.p1;
  assert.equal(next?.agentId, "custom-1");
  assert.equal(next?.accountId, "acct");
  assert.equal(state().accounts.length, 1);
});
