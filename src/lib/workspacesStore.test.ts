import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { useKeel } from "../state/store.ts";
import type { Project } from "./types.ts";

const state = useKeel.getState;

function folder(id: string, path = `/code/${id}`): Project {
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
        tree: null,
        focused: null,
        zoomed: null,
        panes: {},
      },
    ],
  };
}

beforeEach(() => {
  useKeel.setState(useKeel.getInitialState());
});

describe("workspace store", () => {
  it("creates a workspace next to the current project and starts renaming it", () => {
    useKeel.setState({
      projects: [folder("web"), folder("api")],
      sidebar: [
        { kind: "project", id: "web" },
        { kind: "project", id: "api" },
      ],
      activeProjectId: "web",
    });
    const id = state().addWorkspace();
    const next = state();
    assert.equal(next.workspaces.length, 1);
    assert.equal(next.workspaces[0].id, id);
    assert.equal(next.workspaces[0].name, "Workspace");
    assert.deepEqual(next.sidebar, [
      { kind: "project", id: "web" },
      { kind: "workspace", id },
      { kind: "project", id: "api" },
    ]);
    assert.deepEqual(next.renaming, {
      kind: "workspace",
      id,
      where: "sidebar",
    });
  });

  it("can start a workspace with a project already inside it", () => {
    useKeel.setState({
      projects: [folder("web"), folder("api")],
      sidebar: [
        { kind: "project", id: "web" },
        { kind: "project", id: "api" },
      ],
      activeProjectId: "web",
    });
    const id = state().addWorkspace("web");
    const workspace = state().workspaces.find((item) => item.id === id)!;
    assert.deepEqual(workspace.projectIds, ["web"]);
    assert.deepEqual(state().sidebar, [
      { kind: "workspace", id },
      { kind: "project", id: "api" },
    ]);
  });

  it("joins, leaves, and dissolves without dropping the project", () => {
    useKeel.setState({
      projects: [folder("web"), folder("api"), folder("docs")],
      sidebar: [
        { kind: "project", id: "web" },
        { kind: "project", id: "api" },
        { kind: "project", id: "docs" },
      ],
      activeProjectId: "web",
    });
    const id = state().addWorkspace();
    state().stopRename();
    state().placeProjectIn("web", { kind: "member", workspaceId: id, index: 0 });
    state().placeProjectIn("api", { kind: "member", workspaceId: id, index: 1 });
    assert.deepEqual(state().workspaces[0].projectIds, ["web", "api"]);
    assert.equal(state().sidebar.some((item) => item.kind === "project" && item.id === "web"), false);

    state().placeProjectIn("api", { kind: "root", index: 0 });
    assert.deepEqual(state().workspaces[0].projectIds, ["web"]);
    assert.equal(state().sidebar[0].kind, "project");
    assert.equal(state().sidebar[0].id, "api");

    state().dissolveWorkspace(id);
    assert.deepEqual(state().workspaces, []);
    assert.ok(state().projects.some((item) => item.id === "web"));
    assert.ok(state().sidebar.some((item) => item.kind === "project" && item.id === "web"));
  });

  it("removes a member from its workspace and keeps a neighbour selected", () => {
    useKeel.setState({
      projects: [folder("web"), folder("api"), folder("docs")],
      workspaces: [
        {
          id: "plat",
          name: "Platform",
          collapsed: false,
          projectIds: ["web", "api"],
          activeProjectId: "web",
        },
      ],
      sidebar: [
        { kind: "workspace", id: "plat" },
        { kind: "project", id: "docs" },
      ],
      activeProjectId: "web",
    });
    state().removeProject("web");
    assert.equal(state().activeProjectId, "api");
    assert.deepEqual(state().workspaces[0].projectIds, ["api"]);
    assert.ok(!state().projects.some((item) => item.id === "web"));
  });

  it("adds a folder straight into a workspace", () => {
    useKeel.setState({
      workspaces: [
        {
          id: "plat",
          name: "Platform",
          collapsed: true,
          projectIds: [],
          activeProjectId: null,
        },
      ],
      sidebar: [{ kind: "workspace", id: "plat" }],
    });
    const project = state().addProject("/code/web", "web", "plat");
    assert.equal(state().activeProjectId, project.id);
    assert.deepEqual(state().workspaces[0].projectIds, [project.id]);
    assert.equal(state().workspaces[0].collapsed, false);
    assert.equal(state().sidebar.length, 1);
  });

  it("selecting a member remembers it as the workspace's current project", () => {
    useKeel.setState({
      projects: [folder("web"), folder("api")],
      workspaces: [
        {
          id: "plat",
          name: "Platform",
          collapsed: false,
          projectIds: ["web", "api"],
          activeProjectId: "web",
        },
      ],
      sidebar: [{ kind: "workspace", id: "plat" }],
      activeProjectId: "web",
    });
    state().selectProject("api");
    assert.equal(state().workspaces[0].activeProjectId, "api");
    state().selectWorkspace("plat");
    assert.equal(state().activeProjectId, "api");
  });
});
