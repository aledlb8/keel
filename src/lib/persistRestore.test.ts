import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";

import { fileTabId } from "./editorRefs.ts";
import type { AgentAccount, Pane, PersistedState, Project } from "./types.ts";
import { useKeel } from "../state/store.ts";
import { useWorkspace } from "../state/workspace.ts";

const state = useKeel.getState;

function shell(id: string, extra: Partial<Pane> = {}): Pane {
  return {
    id,
    agentId: extra.agentId ?? null,
    accountId: extra.accountId ?? null,
    resumeAgent: extra.resumeAgent ?? extra.agentId != null,
    sessionId: extra.sessionId ?? null,
    sessionReady: extra.sessionReady ?? false,
    title: extra.title ?? "Shell",
    cwd: extra.cwd ?? null,
    ...(extra.editor ? { editor: extra.editor } : {}),
  };
}

function folder(
  id: string,
  panes: Record<string, Pane> = {},
  path = `/code/${id}`,
): Project {
  const first = Object.keys(panes)[0] ?? null;
  return {
    id,
    name: id,
    path,
    collapsed: false,
    activeDeckId: "deck",
    decks: [
      {
        id: "deck",
        name: "Deck 1",
        tree: first ? { kind: "pane", id: first } : null,
        focused: first,
        zoomed: null,
        panes,
      },
    ],
  };
}

function documentOf(payload: unknown): PersistedState | null {
  if (!payload || typeof payload !== "object") return null;
  if ("state" in payload && payload.state && typeof payload.state === "object") {
    return payload.state as PersistedState;
  }
  if ("version" in payload) return payload as PersistedState;
  return null;
}

function dirtyAt(root: string, rel = "a.ts") {
  const id = fileTabId(rel);
  useWorkspace.setState({
    root,
    editors: [{ id, kind: "file", rel, staged: false, name: rel }],
    buffers: { [id]: "edited" },
    originals: { [id]: "original" },
  });
}

let confirmAnswer = true;
let confirmCalls = 0;
let saved: PersistedState[] = [];

beforeEach(() => {
  confirmAnswer = true;
  confirmCalls = 0;
  saved = [];
  Object.assign(globalThis, {
    window: {
      confirm: () => {
        confirmCalls += 1;
        return confirmAnswer;
      },
    },
  });
  useKeel.setState(useKeel.getInitialState());
  useWorkspace.setState(useWorkspace.getInitialState());
  mockIPC((cmd, payload) => {
    if (cmd === "detect_agents") return [];
    if (cmd === "state_load") return Promise.reject("corrupt");
    if (cmd === "state_save") {
      const document = documentOf(payload);
      if (document) saved.push(document);
      return;
    }
    if (cmd === "agent_catalogue_save") return [];
    return null;
  });
});

describe("persist after restore", () => {
  it("does not write keel.json after a failed init", async () => {
    await state().init();
    assert.equal(state().restoreStatus, "failed");
    assert.equal(state().ready, true);
    state().addProject("/code/x", "x");
    state().flushPersist();
    assert.equal(saved.length, 0);
  });

  it("resetLayout after a failed restore writes an empty document and keeps accounts", async () => {
    const accounts: AgentAccount[] = [
      { id: "acct_1", agentId: "grok", name: "Work" },
    ];
    await state().init();
    useKeel.setState({
      accounts,
      projects: [folder("web")],
      ready: true,
      restoreStatus: "failed",
    });
    state().resetLayout();
    state().flushPersist();
    assert.equal(state().restoreStatus, "idle");
    assert.deepEqual(state().projects, []);
    assert.deepEqual(state().accounts, accounts);
    assert.ok(saved.length >= 1);
    const last = saved.at(-1);
    assert.ok(last);
    assert.deepEqual(last.projects, []);
    assert.deepEqual(last.accounts, accounts);
  });

  it("retryRestore that succeeds allows persist again", async () => {
    let failLoad = true;
    mockIPC((cmd, payload) => {
      if (cmd === "detect_agents") return [];
      if (cmd === "state_load") {
        if (failLoad) return Promise.reject("corrupt");
        return {
          version: 5,
          projects: [],
          workspaces: [],
          sidebar: [],
          activeProjectId: null,
          accounts: [],
        };
      }
      if (cmd === "state_save") {
        const document = documentOf(payload);
        if (document) saved.push(document);
        return;
      }
      return null;
    });
    await state().init();
    assert.equal(state().restoreStatus, "failed");
    state().flushPersist();
    assert.equal(saved.length, 0);
    failLoad = false;
    await state().retryRestore();
    assert.notEqual(state().restoreStatus, "failed");
    assert.ok(saved.length >= 1);
  });
});

describe("removeProject unsaved confirm", () => {
  it("keeps the project when confirm is cancelled", () => {
    confirmAnswer = false;
    useKeel.setState({
      ready: true,
      restoreStatus: "idle",
      projects: [folder("web")],
      sidebar: [{ kind: "project", id: "web" }],
      activeProjectId: "web",
    });
    dirtyAt("/code/web");
    useWorkspace.getState().removeProjectSafely("web");
    assert.equal(confirmCalls, 1);
    assert.ok(state().projects.some((project) => project.id === "web"));
  });

  it("removes the project when confirm is accepted", () => {
    confirmAnswer = true;
    useKeel.setState({
      ready: true,
      restoreStatus: "idle",
      projects: [folder("web")],
      sidebar: [{ kind: "project", id: "web" }],
      activeProjectId: "web",
    });
    dirtyAt("/code/web");
    useWorkspace.getState().removeProjectSafely("web");
    assert.equal(confirmCalls, 1);
    assert.ok(!state().projects.some((project) => project.id === "web"));
  });

  it("does not prompt when the on-screen folder is a different project", () => {
    useKeel.setState({
      ready: true,
      restoreStatus: "idle",
      projects: [folder("web"), folder("api")],
      sidebar: [
        { kind: "project", id: "web" },
        { kind: "project", id: "api" },
      ],
      activeProjectId: "web",
    });
    dirtyAt("/code/api");
    useWorkspace.getState().removeProjectSafely("web");
    assert.equal(confirmCalls, 0);
    assert.ok(!state().projects.some((project) => project.id === "web"));
  });

  it("keeps a deck when confirm is cancelled", () => {
    confirmAnswer = false;
    useKeel.setState({
      ready: true,
      restoreStatus: "idle",
      projects: [
        folder("web", {
          ed: shell("ed", {
            title: "a.ts",
            editor: {
              tabs: [{ kind: "file", rel: "a.ts", staged: false }],
              active: fileTabId("a.ts"),
            },
          }),
        }),
      ],
      activeProjectId: "web",
    });
    dirtyAt("/code/web");
    useWorkspace.getState().removeDeckSafely("web", "deck");
    assert.equal(confirmCalls, 1);
    assert.equal(state().projects[0]?.decks[0]?.id, "deck");
    assert.ok(state().projects[0]?.decks[0]?.panes.ed);
  });
});

describe("bindSession", () => {
  it("no-ops on ids that fail isSessionId", () => {
    useKeel.setState({
      ready: true,
      restoreStatus: "idle",
      projects: [folder("web", { pane: shell("pane", { agentId: "grok" }) })],
      activeProjectId: "web",
    });
    state().bindSession("pane", "has space");
    state().bindSession("pane", "");
    state().bindSession("pane", "id;rm");
    const pane = state().projects[0]?.decks[0]?.panes.pane;
    assert.ok(pane);
    assert.equal(pane.sessionId, null);
    assert.equal(pane.sessionReady, false);
    state().bindSession("pane", "abc-123");
    const bound = state().projects[0]?.decks[0]?.panes.pane;
    assert.ok(bound);
    assert.equal(bound.sessionId, "abc-123");
    assert.equal(bound.sessionReady, true);
  });
});

describe("saveAgents dangling panes", () => {
  it("clears pane agent and session fields when the catalogue id disappears", async () => {
    useKeel.setState({
      ready: true,
      restoreStatus: "idle",
      projects: [
        folder("web", {
          pane: shell("pane", {
            agentId: "gone",
            accountId: "acct_1",
            resumeAgent: true,
            sessionId: "abc-123",
            sessionReady: true,
            title: "Gone",
          }),
        }),
      ],
      accounts: [{ id: "acct_1", agentId: "gone", name: "Work" }],
    });
    await state().saveAgents([]);
    const pane = state().projects[0]?.decks[0]?.panes.pane;
    assert.ok(pane);
    assert.equal(pane.agentId, null);
    assert.equal(pane.accountId, null);
    assert.equal(pane.resumeAgent, false);
    assert.equal(pane.sessionId, null);
    assert.equal(pane.sessionReady, false);
    assert.equal(pane.id, "pane");
  });
});
