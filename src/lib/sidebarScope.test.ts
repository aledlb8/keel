import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALL_SCOPE,
  LOOSE_SCOPE,
  filterProjects,
  groupDropTarget,
  matchesOutsideScope,
  parseScope,
  projectDropTarget,
  projectsInScope,
  sameScope,
  scopeHolds,
  scopeName,
  scopeOf,
  scopeOptions,
} from "./sidebarScope.ts";
import type { Deck, Pane, Project, SidebarRoot, Workspace } from "./types.ts";

function pane(id: string, title: string): Pane {
  return {
    id,
    agentId: null,
    accountId: null,
    resumeAgent: false,
    sessionId: null,
    sessionReady: false,
    title,
    cwd: null,
  };
}

function deck(id: string, panes: Pane[]): Deck {
  return {
    id,
    name: "Deck",
    tree:
      panes.length === 0
        ? null
        : panes.length === 1
          ? { kind: "pane", id: panes[0]!.id }
          : {
              kind: "split",
              id: `${id}-split`,
              direction: "row",
              children: panes.map((item) => ({ kind: "pane" as const, id: item.id })),
              sizes: panes.map(() => 1 / panes.length),
            },
    panes: Object.fromEntries(panes.map((item) => [item.id, item])),
    zoomed: null,
    focused: panes[0]?.id ?? null,
  };
}

function project(id: string, name: string, panes: Pane[] = []): Project {
  return {
    id,
    name,
    path: `/src/${id}`,
    decks: [deck(`${id}-d1`, panes)],
    activeDeckId: `${id}-d1`,
    collapsed: false,
  };
}

function workspace(id: string, name: string, projectIds: string[]): Workspace {
  return {
    id,
    name,
    collapsed: false,
    projectIds,
    activeProjectId: projectIds[0] ?? null,
  };
}

/*
 * One fixture used throughout: two grouped projects, one loose one.
 *
 *   Acme          (workspace w1)
 *     api         claude, tests
 *     web         deploy
 *   scratch       (loose)
 */
const api = project("api", "api-server", [
  pane("p1", "claude"),
  pane("p2", "tests"),
]);
const web = project("web", "web", [pane("p3", "deploy")]);
const scratch = project("scratch", "scratch", [pane("p4", "shell")]);
const projects = [api, web, scratch];
const workspaces = [workspace("w1", "Acme", ["api", "web"])];
const sidebar: SidebarRoot[] = [
  { kind: "workspace", id: "w1" },
  { kind: "project", id: "scratch" },
];

const names = (entries: { project: Project }[]) =>
  entries.map((entry) => entry.project.id);

describe("scope identity", () => {
  it("round-trips through storage", () => {
    assert.ok(sameScope(parseScope("all", workspaces), ALL_SCOPE));
    assert.ok(sameScope(parseScope("loose", workspaces), LOOSE_SCOPE));
    assert.ok(
      sameScope(parseScope("workspace:w1", workspaces), {
        kind: "workspace",
        id: "w1",
      }),
    );
  });

  it("falls back to all projects when the workspace is gone", () => {
    assert.ok(sameScope(parseScope("workspace:nope", workspaces), ALL_SCOPE));
    assert.ok(sameScope(parseScope(null, workspaces), ALL_SCOPE));
  });

  it("names itself", () => {
    assert.equal(scopeName({ kind: "workspace", id: "w1" }, workspaces), "Acme");
    assert.equal(scopeName(ALL_SCOPE, workspaces), "All projects");
    assert.equal(scopeName(LOOSE_SCOPE, workspaces), "Ungrouped");
  });

  it("finds the scope holding a project", () => {
    assert.deepEqual(scopeOf(workspaces, "api"), { kind: "workspace", id: "w1" });
    assert.deepEqual(scopeOf(workspaces, "scratch"), LOOSE_SCOPE);
  });

  it("knows what each scope shows", () => {
    const acme = { kind: "workspace", id: "w1" } as const;
    assert.equal(scopeHolds(workspaces, acme, "api"), true);
    assert.equal(scopeHolds(workspaces, acme, "scratch"), false);
    assert.equal(scopeHolds(workspaces, LOOSE_SCOPE, "scratch"), true);
    assert.equal(scopeHolds(workspaces, LOOSE_SCOPE, "api"), false);
    assert.equal(scopeHolds(workspaces, ALL_SCOPE, "api"), true);
  });
});

describe("scopeOptions", () => {
  it("offers all projects, each workspace, then the ungrouped ones", () => {
    const options = scopeOptions(projects, workspaces, sidebar);
    assert.deepEqual(
      options.map((option) => option.key),
      ["all", "workspace:w1", "loose"],
    );
  });

  it("counts projects and terminals", () => {
    const [all, acme, loose] = scopeOptions(projects, workspaces, sidebar);
    assert.deepEqual([all!.count, all!.terminals], [3, 4]);
    assert.deepEqual([acme!.count, acme!.terminals], [2, 3]);
    assert.deepEqual([loose!.count, loose!.terminals], [1, 1]);
  });

  it("drops the ungrouped entry when there are no workspaces", () => {
    const options = scopeOptions([scratch], [], [{ kind: "project", id: "scratch" }]);
    assert.deepEqual(
      options.map((option) => option.key),
      ["all"],
    );
  });
});

describe("projectsInScope", () => {
  it("shows only a workspace's members", () => {
    const scoped = projectsInScope(projects, workspaces, sidebar, {
      kind: "workspace",
      id: "w1",
    });
    assert.deepEqual(names(scoped), ["api", "web"]);
  });

  it("gives members no heading inside their own workspace", () => {
    const scoped = projectsInScope(projects, workspaces, sidebar, {
      kind: "workspace",
      id: "w1",
    });
    assert.deepEqual(
      scoped.map((entry) => entry.groupName),
      [null, null],
    );
  });

  it("shows only ungrouped projects in the loose scope", () => {
    const scoped = projectsInScope(projects, workspaces, sidebar, LOOSE_SCOPE);
    assert.deepEqual(names(scoped), ["scratch"]);
  });

  it("groups everything under headings in the all scope", () => {
    const scoped = projectsInScope(projects, workspaces, sidebar, ALL_SCOPE);
    assert.deepEqual(names(scoped), ["api", "web", "scratch"]);
    assert.deepEqual(
      scoped.map((entry) => entry.groupName),
      ["Acme", "Acme", null],
    );
  });

  it("collects ungrouped projects into one trailing run, however they were saved", () => {
    // "scratch" saved *before* the workspace: drawn literally, the dock would
    // caption "Ungrouped" once at the top and again at the bottom.
    const shuffled: SidebarRoot[] = [
      { kind: "project", id: "scratch" },
      { kind: "workspace", id: "w1" },
      { kind: "project", id: "spare" },
    ];
    const spare = project("spare", "spare");
    const scoped = projectsInScope(
      [...projects, spare],
      workspaces,
      shuffled,
      ALL_SCOPE,
    );
    assert.deepEqual(names(scoped), ["api", "web", "scratch", "spare"]);
    assert.deepEqual(
      scoped.map((entry) => entry.groupName),
      ["Acme", "Acme", null, null],
    );
  });

  it("keeps the saved order within the ungrouped run", () => {
    const spare = project("spare", "spare");
    const scoped = projectsInScope(
      [...projects, spare],
      workspaces,
      [
        { kind: "project", id: "spare" },
        { kind: "workspace", id: "w1" },
        { kind: "project", id: "scratch" },
      ],
      ALL_SCOPE,
    );
    assert.deepEqual(names(scoped), ["api", "web", "spare", "scratch"]);
  });

  it("is empty for a workspace that no longer exists", () => {
    const scoped = projectsInScope(projects, workspaces, sidebar, {
      kind: "workspace",
      id: "gone",
    });
    assert.deepEqual(scoped, []);
  });
});

describe("filterProjects", () => {
  const scoped = projectsInScope(projects, workspaces, sidebar, ALL_SCOPE);

  it("passes everything through when there is no query", () => {
    assert.deepEqual(names(filterProjects(scoped, "   ")), [
      "api",
      "web",
      "scratch",
    ]);
  });

  it("keeps a whole project when its own name matches", () => {
    const hits = filterProjects(scoped, "api");
    assert.deepEqual(names(hits), ["api"]);
    assert.equal(hits[0]!.panes, null);
  });

  it("keeps only the terminals that match", () => {
    const hits = filterProjects(scoped, "tests");
    assert.deepEqual(names(hits), ["api"]);
    assert.deepEqual(hits[0]!.panes, ["p2"]);
  });

  it("returns nothing when nothing matches", () => {
    assert.deepEqual(filterProjects(scoped, "zzzz"), []);
  });
});

describe("matchesOutsideScope", () => {
  const acme = { kind: "workspace", id: "w1" } as const;

  it("counts projects the current scope is hiding", () => {
    assert.equal(matchesOutsideScope(projects, workspaces, acme, "scratch"), 1);
  });

  it("counts a hidden project by its terminals too", () => {
    assert.equal(matchesOutsideScope(projects, workspaces, acme, "shell"), 1);
  });

  it("ignores matches already on screen", () => {
    assert.equal(matchesOutsideScope(projects, workspaces, acme, "api"), 0);
  });

  it("is zero without a query, and zero when nothing is hidden", () => {
    assert.equal(matchesOutsideScope(projects, workspaces, acme, ""), 0);
    assert.equal(matchesOutsideScope(projects, workspaces, ALL_SCOPE, "shell"), 0);
  });
});

describe("projectDropTarget", () => {
  it("reorders inside a workspace, counting without the moved project", () => {
    assert.deepEqual(projectDropTarget(workspaces, sidebar, "api", "web", true), {
      kind: "member",
      workspaceId: "w1",
      index: 1,
    });
    assert.deepEqual(projectDropTarget(workspaces, sidebar, "api", "web", false), {
      kind: "member",
      workspaceId: "w1",
      index: 0,
    });
  });

  it("joins the workspace when dropped onto one of its members", () => {
    assert.deepEqual(
      projectDropTarget(workspaces, sidebar, "scratch", "api", false),
      { kind: "member", workspaceId: "w1", index: 0 },
    );
  });

  it("leaves the workspace when dropped onto a loose project", () => {
    assert.deepEqual(
      projectDropTarget(workspaces, sidebar, "api", "scratch", true),
      { kind: "root", index: 2 },
    );
  });

  it("refuses to drop a project onto itself", () => {
    assert.equal(projectDropTarget(workspaces, sidebar, "api", "api", true), null);
  });

  it("refuses an unknown target", () => {
    assert.equal(projectDropTarget(workspaces, sidebar, "api", "ghost", true), null);
  });
});

describe("groupDropTarget", () => {
  it("appends to the group, counting without the moved project", () => {
    assert.deepEqual(groupDropTarget(workspaces, "scratch", "w1"), {
      kind: "member",
      workspaceId: "w1",
      index: 2,
    });
    assert.deepEqual(groupDropTarget(workspaces, "api", "w1"), {
      kind: "member",
      workspaceId: "w1",
      index: 1,
    });
  });

  it("refuses an unknown group", () => {
    assert.equal(groupDropTarget(workspaces, "api", "gone"), null);
  });
});
