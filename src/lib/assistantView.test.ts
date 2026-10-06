import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANSWER_KEYS,
  INTERRUPT_KEYS,
  PANE_KEYS,
  describeUsage,
  describeWorkspace,
  findProject,
  paneChanges,
  type WorkspaceView,
} from "./assistantView.ts";
import type { Agent, Pane, Project } from "./types.ts";
import type { AgentUsage } from "./usage.ts";

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
    handed: new Set(),
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

  it("marks a pane of the user's that the agent passed a request to", () => {
    const text = describeWorkspace(view({ handed: new Set(["c"]) }));
    assert.match(text, /- c: Claude Code, waiting for input, "Docs" \(in C:\\code\\keel\\docs, you passed it a request\)/);
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

  it("counts working to idle as finished only for panes the agent is waiting on", () => {
    const before = { status: { a: "working" as const, b: "working" as const }, exited: {} };
    const after = { status: { a: "idle" as const, b: "idle" as const }, exited: {} };
    assert.deepEqual(paneChanges(before, after, new Set(["a"])), [{ paneId: "a", kind: "done" }]);
  });
});

describe("describeUsage", () => {
  const now = Date.UTC(2026, 9, 5, 12);
  const usage = (extra: Partial<AgentUsage>): AgentUsage => ({
    agentId: "claude",
    accountId: null,
    short: "CL",
    name: "Claude Code",
    accent: "",
    plan: "Max",
    windows: [],
    status: "ok",
    error: null,
    updatedAt: now,
    ...extra,
  });

  it("gives each login its windows, use and reset", () => {
    const text = describeUsage(
      [
        usage({
          windows: [
            { label: "5h", usedPercent: 41.6, windowMinutes: 300, resetsAt: now + 95 * 60_000 },
            { label: "wk", usedPercent: 12, windowMinutes: 10080, resetsAt: null },
          ],
        }),
        usage({ agentId: "codex", name: "Codex", plan: null, accountId: "work", status: "error", error: "login expired" }),
      ],
      [{ id: "work", agentId: "codex", name: "Work" }],
      now,
    );
    assert.equal(
      text,
      "Claude Code, Max: 5-hour 42% used, resets in 1h 35m; Weekly 12% used.\n" +
        "Codex (Work): couldn't read it (login expired).",
    );
  });

  it("says so when nothing could be read", () => {
    assert.equal(describeUsage([], [], now), "Keel couldn't read usage for any signed-in agent.");
  });
});

describe("PANE_KEYS", () => {
  it("sends the bytes a terminal would", () => {
    assert.equal(PANE_KEYS.escape, "\x1b");
    assert.equal(PANE_KEYS.ctrl_c, "\x03");
    assert.equal(PANE_KEYS.up, "\x1b[A");
  });

  it("presses numbers as keys, so a menu takes them as a choice", () => {
    assert.equal(PANE_KEYS["1"], "1");
    assert.equal(PANE_KEYS["9"], "9");
    assert.equal(PANE_KEYS["0"], undefined);
  });

  it("tells answering keys from interrupting ones", () => {
    for (const key of ["enter", "1", "4"]) assert.ok(ANSWER_KEYS.has(key), key);
    for (const key of ["escape", "ctrl_c"]) assert.ok(INTERRUPT_KEYS.has(key), key);
    for (const key of ["up", "down", "tab"]) {
      assert.ok(!ANSWER_KEYS.has(key) && !INTERRUPT_KEYS.has(key), key);
    }
    for (const key of [...ANSWER_KEYS, ...INTERRUPT_KEYS]) assert.ok(key in PANE_KEYS, key);
  });
});
