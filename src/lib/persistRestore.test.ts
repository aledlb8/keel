import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applySession } from "./launch.ts";

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
  it("round-trips concurrent chats through disk, process replacement, and a full store reload", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "keel-restore-"));
    const file = path.join(directory, "keel.json");
    const providers = ["claude", "codex", "grok", "opencode"];
    try {
      mockIPC(async (cmd, payload) => {
        if (cmd === "detect_agents") return [];
        if (cmd === "state_load") return JSON.parse(await readFile(file, "utf8"));
        if (cmd === "state_save") {
          await writeFile(`${file}.tmp`, JSON.stringify(documentOf(payload)));
          await rename(`${file}.tmp`, file);
        }
        return null;
      });
      const panes = Object.fromEntries(providers.flatMap((agentId) => [0, 1].map((n) => {
        const id = `${agentId}-${n}`;
        return [id, shell(id, { agentId, accountId: n ? "work" : null })];
      })));
      useKeel.setState({ ready: true, projects: [folder("web", panes)], activeProjectId: "web" });
      for (const pane of Object.values(panes)) {
        state().noteActivity(pane.id, "spawn");
        const report = (sessionId: string, processId: string, sequence: number) =>
          state().noteAgentEvent(pane.id, 0, { agentId: pane.agentId!, sessionId, processId, kind: "session", sequence });
        report(`old-${pane.id}`, `old-process-${pane.id}`, 1);
        // First event from a replacement can beat the old watcher's exit.
        report(`new-${pane.id}`, `new-process-${pane.id}`, 2);
        state().releaseAgent(pane.id, 0, `old-process-${pane.id}`);
        state().noteRunningAgent(pane.id, 0, pane.agentId, `new-process-${pane.id}`);
        report(`old-${pane.id}`, `old-process-${pane.id}`, 3);
      }
      await state().flushPersist();
      useKeel.setState(useKeel.getInitialState());
      await state().init();
      const restored = state().projects[0]!.decks[0]!.panes;
      for (const pane of Object.values(panes)) {
        const actual = restored[pane.id]!;
        assert.equal(actual.sessionId, `new-${pane.id}`);
        assert.equal(actual.accountId, pane.accountId);
        assert.equal(actual.resumeAgent, true);
        assert.equal(applySession(pane.agentId!, { resume: "--resume {id}" }, actual),
          `${pane.agentId} --resume "new-${pane.id}"`);
      }
      await state().flushPersist();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes a failed identity save and retries the latest chat without losing it", async () => {
    let fail = true;
    mockIPC((cmd, payload) => {
      if (cmd === "state_save") {
        if (fail) return Promise.reject("disk full");
        saved.push(documentOf(payload)!);
      }
      return null;
    });
    useKeel.setState({ ready: true, projects: [folder("web", { pane: shell("pane", { agentId: "claude" }) })] });
    state().noteActivity("pane", "spawn");
    state().noteAgentEvent("pane", 0, { agentId: "claude", sessionId: "exact-chat", kind: "session", sequence: 1 });
    await assert.rejects(state().flushPersist(), /disk full/);
    assert.equal(state().persistError, "disk full");
    fail = false;
    await state().flushPersist();
    assert.equal(state().persistError, null);
    assert.equal(saved.at(-1)!.projects[0]!.decks[0]!.panes.pane!.sessionId, "exact-chat");
  });
  for (const agentId of ["claude", "codex", "grok", "opencode"]) {
    for (const replacementEvent of ["session", "working"] as const) {
      it(`reopens the second ${agentId} chat in the same terminal after a ${replacementEvent} event`, async () => {
        let releaseFirstSave!: () => void;
        const firstSave = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
        let writes = 0;
        mockIPC(async (cmd, payload) => {
          if (cmd === "detect_agents") return [];
          if (cmd === "state_load") return structuredClone(saved.at(-1));
          if (cmd === "state_save") {
            const document = documentOf(payload);
            if (writes++ === 0) await firstSave;
            if (document) saved.push(structuredClone(document));
          }
          return null;
        });
        useKeel.setState({
          ready: true,
          projects: [folder("web", { pane: shell("pane", { agentId }) })],
          activeProjectId: "web",
        });
        state().noteActivity("pane", "spawn");
        const report = (kind: "session" | "working" | "completed" | "ended", sequence: number, sessionId: string) =>
          state().noteAgentEvent("pane", 0, { agentId, sessionId, kind, sequence });
        report("session", 1, "first-chat");
        report("working", 2, "first-chat");
        report("completed", 3, "first-chat");
        // /new or /clear keeps this PTY and generation alive.
        report(replacementEvent, 4, "second-chat");
        report("completed", 5, "first-chat");
        report("ended", 6, "first-chat");
        assert.equal(state().projects[0]?.decks[0]?.panes.pane?.sessionId, "second-chat");
        const closing = state().flushPersist();
        releaseFirstSave();
        await closing;
        assert.equal(saved.at(-1)?.projects[0]?.decks[0]?.panes.pane?.sessionId, "second-chat");

        useKeel.setState(useKeel.getInitialState());
        await state().init();
        const reopened = state().projects[0]?.decks[0]?.panes.pane;
        assert.equal(reopened?.sessionId, "second-chat");
        assert.equal(reopened?.sessionReady, true);
        assert.equal(reopened?.resumeAgent, true);
        await state().flushPersist();
      });
    }
  }

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
  it("keeps the project when confirm is cancelled", async () => {
    confirmAnswer = false;
    useKeel.setState({
      ready: true,
      restoreStatus: "idle",
      projects: [folder("web")],
      sidebar: [{ kind: "project", id: "web" }],
      activeProjectId: "web",
    });
    dirtyAt("/code/web");
    await useWorkspace.getState().removeProjectSafely("web");
    assert.equal(confirmCalls, 1);
    assert.ok(state().projects.some((project) => project.id === "web"));
  });

  it("removes the project when confirm is accepted", async () => {
    confirmAnswer = true;
    useKeel.setState({
      ready: true,
      restoreStatus: "idle",
      projects: [folder("web")],
      sidebar: [{ kind: "project", id: "web" }],
      activeProjectId: "web",
    });
    dirtyAt("/code/web");
    await useWorkspace.getState().removeProjectSafely("web");
    assert.equal(confirmCalls, 1);
    assert.ok(!state().projects.some((project) => project.id === "web"));
  });

  it("does not prompt when the on-screen folder is a different project", async () => {
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
    await useWorkspace.getState().removeProjectSafely("web");
    assert.equal(confirmCalls, 0);
    assert.ok(!state().projects.some((project) => project.id === "web"));
  });

  it("keeps a deck when confirm is cancelled", async () => {
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
    await useWorkspace.getState().removeDeckSafely("web", "deck");
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
