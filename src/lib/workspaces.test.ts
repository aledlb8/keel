import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Project, SidebarRoot, Workspace } from "./types.ts";
import {
  dissolveWorkspace,
  emptyWorkspace,
  forgetProject,
  insertWorkspace,
  isStandalone,
  nextWorkspaceName,
  normalizeWorkspaces,
  orderedProjects,
  placeProject,
  rememberWorkspaceProject,
  repairSidebar,
  reorderRoot,
  rootIndexOfProject,
  shiftMember,
  shiftRoot,
  workspaceOf,
} from "./workspaces.ts";

function project(id: string, name = id): Project {
  return {
    id,
    name,
    path: `/code/${id}`,
    decks: [],
    activeDeckId: null,
    collapsed: false,
  };
}

function group(
  id: string,
  members: string[],
  extra: Partial<Workspace> = {},
): Workspace {
  return {
    id,
    name: id,
    collapsed: false,
    projectIds: members,
    activeProjectId: members[0] ?? null,
    ...extra,
  };
}

const web = project("web");
const api = project("api");
const docs = project("docs");
const scratch = project("scratch");

describe("normalizeWorkspaces", () => {
  it("drops unknown projects, duplicate membership, and duplicate ids", () => {
    const raw = [
      { id: "w1", name: " Platform ", projectIds: ["web", "ghost", "web", "api"] },
      { id: "w1", name: "again", projectIds: ["docs"] },
      { id: "w2", name: "Other", projectIds: ["api", "docs"] },
      { id: 3, name: "nope" },
      null,
    ];
    const workspaces = normalizeWorkspaces(raw, new Set(["web", "api", "docs"]));
    assert.deepEqual(
      workspaces.map((item) => ({
        id: item.id,
        name: item.name,
        projectIds: item.projectIds,
        activeProjectId: item.activeProjectId,
      })),
      [
        { id: "w1", name: "Platform", projectIds: ["web", "api"], activeProjectId: "web" },
        { id: "w2", name: "Other", projectIds: ["docs"], activeProjectId: "docs" },
      ],
    );
  });

  it("repairs a stale active member and treats a missing list as empty", () => {
    const [workspace] = normalizeWorkspaces(
      [{ id: "w", name: "W", collapsed: true, activeProjectId: "gone" }],
      new Set(["web"]),
    );
    assert.ok(workspace);
    assert.equal(workspace.collapsed, true);
    assert.deepEqual(workspace.projectIds, []);
    assert.equal(workspace.activeProjectId, null);
  });

  it("is empty for anything that is not an array", () => {
    assert.deepEqual(normalizeWorkspaces(null, new Set()), []);
    assert.deepEqual(normalizeWorkspaces({}, new Set()), []);
  });
});

describe("repairSidebar", () => {
  it("keeps saved order and appends anything the save forgot", () => {
    const workspaces = [group("plat", ["web", "api"])];
    const projects = [web, api, docs, scratch];
    const saved: SidebarRoot[] = [
      { kind: "project", id: "scratch" },
      { kind: "workspace", id: "ghost" },
      { kind: "project", id: "web" },
      { kind: "workspace", id: "plat" },
    ];
    assert.deepEqual(repairSidebar(projects, workspaces, saved), [
      { kind: "project", id: "scratch" },
      { kind: "workspace", id: "plat" },
      { kind: "project", id: "docs" },
    ]);
  });

  it("builds a standalone list when nothing was saved", () => {
    assert.deepEqual(repairSidebar([web, api], [], undefined), [
      { kind: "project", id: "web" },
      { kind: "project", id: "api" },
    ]);
  });
});

describe("orderedProjects", () => {
  it("walks workspaces then their members, then leftover projects", () => {
    const workspaces = [group("plat", ["api", "web"])];
    const sidebar: SidebarRoot[] = [
      { kind: "workspace", id: "plat" },
      { kind: "project", id: "scratch" },
    ];
    assert.deepEqual(
      orderedProjects([web, api, scratch, docs], workspaces, sidebar).map(
        (item) => item.id,
      ),
      ["api", "web", "scratch", "docs"],
    );
  });
});

describe("placeProject", () => {
  it("joins a standalone project onto a workspace and expands it", () => {
    const workspaces = [group("plat", ["web"], { collapsed: true })];
    const sidebar: SidebarRoot[] = [
      { kind: "workspace", id: "plat" },
      { kind: "project", id: "api" },
    ];
    const next = placeProject(workspaces, sidebar, "api", {
      kind: "member",
      workspaceId: "plat",
      index: 0,
    });
    assert.deepEqual(next.sidebar, [{ kind: "workspace", id: "plat" }]);
    assert.deepEqual(next.workspaces[0]?.projectIds, ["api", "web"]);
    assert.equal(next.workspaces[0]?.collapsed, false);
  });

  it("leaves a workspace and lands at a top-level index", () => {
    const workspaces = [group("plat", ["web", "api"])];
    const sidebar: SidebarRoot[] = [
      { kind: "workspace", id: "plat" },
      { kind: "project", id: "scratch" },
    ];
    const next = placeProject(workspaces, sidebar, "api", {
      kind: "root",
      index: 0,
    });
    assert.deepEqual(next.sidebar, [
      { kind: "project", id: "api" },
      { kind: "workspace", id: "plat" },
      { kind: "project", id: "scratch" },
    ]);
    assert.deepEqual(next.workspaces[0]?.projectIds, ["web"]);
    assert.equal(next.workspaces[0]?.activeProjectId, "web");
  });

  it("reorders members inside the same workspace", () => {
    const workspaces = [group("plat", ["web", "api", "docs"])];
    const next = placeProject(workspaces, [{ kind: "workspace", id: "plat" }], "docs", {
      kind: "member",
      workspaceId: "plat",
      index: 0,
    });
    assert.deepEqual(next.workspaces[0]?.projectIds, ["docs", "web", "api"]);
  });

  it("moves a project from one workspace to another", () => {
    const workspaces = [group("a", ["web"]), group("b", ["api"])];
    const sidebar: SidebarRoot[] = [
      { kind: "workspace", id: "a" },
      { kind: "workspace", id: "b" },
    ];
    const next = placeProject(workspaces, sidebar, "web", {
      kind: "member",
      workspaceId: "b",
      index: 1,
    });
    assert.deepEqual(
      next.workspaces.map((item) => item.projectIds),
      [[], ["api", "web"]],
    );
  });
});

describe("forgetProject / dissolveWorkspace", () => {
  it("drops a project from its group and from the top-level list", () => {
    const workspaces = [group("plat", ["web", "api"])];
    const sidebar: SidebarRoot[] = [
      { kind: "workspace", id: "plat" },
      { kind: "project", id: "scratch" },
    ];
    const nested = forgetProject(workspaces, sidebar, "web");
    assert.deepEqual(nested.workspaces[0]?.projectIds, ["api"]);
    const root = forgetProject(workspaces, sidebar, "scratch");
    assert.deepEqual(root.sidebar, [{ kind: "workspace", id: "plat" }]);
  });

  it("ungroups members in place, without deleting them", () => {
    const workspaces = [group("plat", ["web", "api"])];
    const sidebar: SidebarRoot[] = [
      { kind: "project", id: "scratch" },
      { kind: "workspace", id: "plat" },
    ];
    const next = dissolveWorkspace(workspaces, sidebar, "plat");
    assert.deepEqual(next.workspaces, []);
    assert.deepEqual(next.sidebar, [
      { kind: "project", id: "scratch" },
      { kind: "project", id: "web" },
      { kind: "project", id: "api" },
    ]);
  });
});

describe("insert / shift / remember", () => {
  it("inserts a workspace at a counted index", () => {
    const workspace = emptyWorkspace("wks", "Workspace");
    const next = insertWorkspace([], [{ kind: "project", id: "web" }], workspace, 0);
    assert.deepEqual(next.sidebar, [
      { kind: "workspace", id: "wks" },
      { kind: "project", id: "web" },
    ]);
    assert.equal(next.workspaces[0]?.name, "Workspace");
  });

  it("shifts roots and members by one place", () => {
    const sidebar: SidebarRoot[] = [
      { kind: "workspace", id: "a" },
      { kind: "project", id: "web" },
      { kind: "workspace", id: "b" },
    ];
    assert.deepEqual(shiftRoot(sidebar, { kind: "project", id: "web" }, 1), [
      { kind: "workspace", id: "a" },
      { kind: "workspace", id: "b" },
      { kind: "project", id: "web" },
    ]);
    assert.deepEqual(
      shiftMember([group("a", ["web", "api", "docs"])], "a", "web", 1)[0]?.projectIds,
      ["api", "web", "docs"],
    );
  });

  it("reorders a root using an index counted without it", () => {
    const sidebar: SidebarRoot[] = [
      { kind: "project", id: "a" },
      { kind: "project", id: "b" },
      { kind: "project", id: "c" },
    ];
    assert.deepEqual(reorderRoot(sidebar, { kind: "project", id: "a" }, 2), [
      { kind: "project", id: "b" },
      { kind: "project", id: "c" },
      { kind: "project", id: "a" },
    ]);
  });

  it("remembers the last member you were in", () => {
    const next = rememberWorkspaceProject([group("plat", ["web", "api"])], "plat", "api");
    assert.equal(next[0]?.activeProjectId, "api");
  });
});

describe("names and lookup", () => {
  it("skips names already in use", () => {
    assert.equal(nextWorkspaceName([]), "Workspace");
    assert.equal(nextWorkspaceName([group("Workspace", [])]), "Workspace 2");
    assert.equal(
      nextWorkspaceName([group("Workspace", []), group("Workspace 2", [])]),
      "Workspace 3",
    );
  });

  it("finds membership and the containing root", () => {
    const workspaces = [group("plat", ["web"])];
    const sidebar: SidebarRoot[] = [
      { kind: "project", id: "scratch" },
      { kind: "workspace", id: "plat" },
    ];
    assert.equal(workspaceOf(workspaces, "web")?.id, "plat");
    assert.equal(isStandalone(workspaces, "scratch"), true);
    assert.equal(isStandalone(workspaces, "web"), false);
    assert.equal(rootIndexOfProject(workspaces, sidebar, "web"), 1);
    assert.equal(rootIndexOfProject(workspaces, sidebar, "scratch"), 0);
  });
});
