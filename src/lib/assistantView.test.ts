import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeWorkspace, findProject, paneChanges, type WorkspaceView } from "./assistantView.ts";
import type { Agent, Pane, Project } from "./types.ts";

function agent(id: string, name: string, installed = true): Agent {
  return {
    id,
    name,
    command: id,
    short: id.slice(0, 2).toUpperCase(),
    accent: "",
    bins: [],
    paths: [],
    path: installed ? `/bin/${id}` : null,
    installed,
    builtin: true,
  };
}

function pane(id: string, agentId: string | null, title: string, extra: Partial<Pane> = {}): Pane {
  return {
    id,
    agentId,
    accountId: null,
    resumeAgent: agentId !== null,
    sessionId: null,
    sessionReady: false,
    title,
    cwd: null,
    ...extra,
  };
}

function project(id: string, name: string, path: string, panes: Pane[]): Project {
  return {
    id,
    name,
    path,
    collapsed: false,
    activeDeckId: "d1",
    decks: [
      {
        id: "d1",
        name: "Deck 1",
        zoomed: null,
        focused: null,
        tree:
          panes.length === 0
            ? null
            : {
                kind: "split",
                id: "s1",
                direction: "row",
                sizes: panes.map(() => 1 / panes.length),
                children: panes.map((item) => ({ kind: "pane" as const, id: item.id })),
              },
        panes: Object.fromEntries(panes.map((item) => [item.id, item])),
      },
    ],
  };
}

const keel = project("p1", "keel", "C:\\code\\keel", [
  pane("a", "codex", "Fix login"),
  pane("b", null, "Shell"),
  pane("c", "claude", "Docs", { cwd: "C:\\code\\keel\\docs" }),
]);
const site = project("p2", "site", "C:\\code\\site", []);

function view(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    agents: [agent("claude", "Claude Code"), agent("codex", "Codex"), agent("aider", "Aider", false)],
    projects: [keel, site],
    workspaces: [{ id: "w1", name: "Work", collapsed: false, projectIds: ["p2"], activeProjectId: null }],
    activeProjectId: "p1",
    status: { a: "working", c: "waiting" },
    exited: {},
    delegated: new Set(["a"]),
    ...overrides,
  };
}

describe("describeWorkspace", () => {
  it("lists startable agents, projects and panes with what they are doing", () => {
    const text = describeWorkspace(view());
    assert.match(text, /^Agents you can start: claude \(Claude Code\), codex \(Codex\)$/m);
    assert.doesNotMatch(text, /aider/);
    assert.match(text, /Project "keel" — C:\\code\\keel \(on screen\)/);
    assert.match(text, /- a: Codex, working, "Fix login" \(started by you\)/);
    assert.match(text, /- b: shell, shell prompt, "Shell"/);
    assert.match(text, /- c: Claude Code, waiting for input, "Docs" \(in C:\\code\\keel\\docs\)/);
    assert.match(text, /Project "site" — C:\\code\\site \(workspace Work\)\n {2}\(no panes\)/);
  });

  it("says so when nothing is open", () => {
    assert.match(describeWorkspace(view({ projects: [] })), /No projects are open in Keel\./);
  });

  it("marks exited panes", () => {
    assert.match(describeWorkspace(view({ exited: { a: true } })), /- a: Codex, exited/);
  });
});

describe("findProject", () => {
  it("matches by id, name, path or folder name", () => {
    const projects = [keel, site];
    assert.equal(findProject(projects, "p2"), site);
    assert.equal(findProject(projects, "KEEL"), keel);
    assert.equal(findProject(projects, "c:/code/site/"), site);
    assert.equal(findProject(projects, "site"), site);
    assert.equal(findProject(projects, "nope"), null);
    assert.equal(findProject(projects, " "), null);
  });
});

describe("paneChanges", () => {
  const none = new Set<string>();

  it("reports rising edges to done and waiting, and new exits", () => {
    const changes = paneChanges(
      { status: { a: "working", b: "working", c: "done" }, exited: {} },
      { status: { a: "done", b: "waiting", c: "done" }, exited: { d: true } },
      none,
    );
    assert.deepEqual(changes, [
      { paneId: "a", kind: "done" },
      { paneId: "b", kind: "waiting" },
      { paneId: "d", kind: "exited" },
    ]);
  });

  it("counts working to idle as finished only for panes the agent started", () => {
    const before = { status: { a: "working" as const, b: "working" as const }, exited: {} };
    const after = { status: { a: "idle" as const, b: "idle" as const }, exited: {} };
    assert.deepEqual(paneChanges(before, after, new Set(["a"])), [{ paneId: "a", kind: "done" }]);
  });
});
