/**
 * Workspaces: named groups of existing projects.
 *
 * A project is still the unit of work — a folder, its decks, its terminals.
 * A workspace is only a way of arranging those projects in the sidebar. It is
 * not a folder, it does not own processes, and dissolving one never deletes a
 * project.
 *
 * Membership is exclusive: a project is in at most one workspace. Standalone
 * projects sit at the top level of the sidebar alongside workspaces, which is
 * why the saved `sidebar` list is a mix of both.
 *
 * The file inspector (`useWorkspace`, `src/lib/workspace.ts`) is a different
 * thing — the files of the folder you are looking at. That name was here first.
 */

import { moveTo, swapAt } from "./order.ts";
import type { Project, SidebarRoot, Workspace } from "./types.ts";

export type ProjectDestination =
  | { kind: "root"; index: number }
  | { kind: "member"; workspaceId: string; index: number };

export interface Layout {
  workspaces: Workspace[];
  sidebar: SidebarRoot[];
}

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

function shift<T>(items: T[], match: (item: T) => boolean, delta: -1 | 1): T[] {
  const from = items.findIndex(match);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= items.length) return items;
  const next = [...items];
  swapAt(next, from, to);
  return next;
}

function rootKey(entry: SidebarRoot): string {
  return `${entry.kind}:${entry.id}`;
}

/** The workspace that currently holds `projectId`, if any. */
export function workspaceOf(
  workspaces: Workspace[],
  projectId: string,
): Workspace | null {
  return workspaces.find((item) => item.projectIds.includes(projectId)) ?? null;
}

/** Whether `projectId` sits at the top of the sidebar rather than in a group. */
export function isStandalone(
  workspaces: Workspace[],
  projectId: string,
): boolean {
  return workspaceOf(workspaces, projectId) === null;
}

/** "Workspace", then "Workspace 2", skipping names already in use. */
export function nextWorkspaceName(workspaces: Workspace[]): string {
  const taken = new Set(workspaces.map((item) => item.name.toLocaleLowerCase()));
  if (!taken.has("workspace")) return "Workspace";
  for (let n = 2; ; n += 1) {
    const name = `Workspace ${n}`;
    if (!taken.has(name.toLocaleLowerCase())) return name;
  }
}

/**
 * Drop unknown ids, duplicate membership, and empty names. A project that
 * appears in two groups is kept in the first and stripped from the rest.
 */
export function normalizeWorkspaces(
  raw: unknown,
  projectIds: Set<string>,
): Workspace[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const claimed = new Set<string>();
  const result: Workspace[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string") continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);

    const members: string[] = [];
    if (Array.isArray(item.projectIds)) {
      for (const id of item.projectIds) {
        if (typeof id !== "string") continue;
        if (!projectIds.has(id) || claimed.has(id)) continue;
        claimed.add(id);
        members.push(id);
      }
    }

    const active =
      typeof item.activeProjectId === "string" && members.includes(item.activeProjectId)
        ? item.activeProjectId
        : (members[0] ?? null);

    const name = item.name.trim() || "Workspace";
    result.push({
      id: item.id,
      name,
      collapsed: item.collapsed === true,
      projectIds: members,
      activeProjectId: active,
    });
  }

  return result;
}

/**
 * Rebuild the top-level sidebar so it names every workspace and every
 * ungrouped project exactly once, keeping whatever order was saved.
 */
export function repairSidebar(
  projects: Project[],
  workspaces: Workspace[],
  sidebar: unknown,
): SidebarRoot[] {
  const projectIds = new Set(projects.map((project) => project.id));
  const grouped = new Set(workspaces.flatMap((item) => item.projectIds));
  const workspaceIds = new Set(workspaces.map((item) => item.id));
  const seen = new Set<string>();
  const result: SidebarRoot[] = [];

  const incoming = Array.isArray(sidebar) ? sidebar : [];
  for (const entry of incoming) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Partial<SidebarRoot>;
    if (item.kind !== "workspace" && item.kind !== "project") continue;
    if (typeof item.id !== "string") continue;
    const key = rootKey(item as SidebarRoot);
    if (seen.has(key)) continue;
    if (item.kind === "workspace") {
      if (!workspaceIds.has(item.id)) continue;
    } else if (!projectIds.has(item.id) || grouped.has(item.id)) {
      continue;
    }
    seen.add(key);
    result.push({ kind: item.kind, id: item.id });
  }

  for (const workspace of workspaces) {
    const key = `workspace:${workspace.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind: "workspace", id: workspace.id });
  }

  for (const project of projects) {
    if (grouped.has(project.id)) continue;
    const key = `project:${project.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind: "project", id: project.id });
  }

  return result;
}

/** Projects in the order the sidebar shows them, workspace members included. */
export function orderedProjects(
  projects: Project[],
  workspaces: Workspace[],
  sidebar: SidebarRoot[],
): Project[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const roots = repairSidebar(projects, workspaces, sidebar);
  const result: Project[] = [];
  const used = new Set<string>();

  for (const root of roots) {
    if (root.kind === "project") {
      const project = byId.get(root.id);
      if (!project || used.has(project.id)) continue;
      used.add(project.id);
      result.push(project);
      continue;
    }
    const workspace = workspaces.find((item) => item.id === root.id);
    if (!workspace) continue;
    for (const id of workspace.projectIds) {
      const project = byId.get(id);
      if (!project || used.has(project.id)) continue;
      used.add(project.id);
      result.push(project);
    }
  }

  for (const project of projects) {
    if (used.has(project.id)) continue;
    result.push(project);
  }
  return result;
}

/** Pull a project out of every group and off the top-level list. */
export function forgetProject(
  workspaces: Workspace[],
  sidebar: SidebarRoot[],
  projectId: string,
): Layout {
  return {
    workspaces: workspaces.map((workspace) => {
      if (!workspace.projectIds.includes(projectId)) return workspace;
      const projectIds = workspace.projectIds.filter((id) => id !== projectId);
      return {
        ...workspace,
        projectIds,
        activeProjectId:
          workspace.activeProjectId === projectId
            ? (projectIds[0] ?? null)
            : workspace.activeProjectId,
      };
    }),
    sidebar: sidebar.filter(
      (item) => !(item.kind === "project" && item.id === projectId),
    ),
  };
}

/**
 * Put `projectId` at a top-level slot or inside a workspace. Leaves wherever
 * it was sitting first, so the same call covers join, leave, and reorder.
 */
export function placeProject(
  workspaces: Workspace[],
  sidebar: SidebarRoot[],
  projectId: string,
  dest: ProjectDestination,
): Layout {
  const stripped = forgetProject(workspaces, sidebar, projectId);

  if (dest.kind === "root") {
    const next = [...stripped.sidebar];
    next.splice(clamp(dest.index, next.length), 0, {
      kind: "project",
      id: projectId,
    });
    return { workspaces: stripped.workspaces, sidebar: next };
  }

  const workspacesNext = stripped.workspaces.map((workspace) => {
    if (workspace.id !== dest.workspaceId) return workspace;
    const projectIds = [...workspace.projectIds];
    projectIds.splice(clamp(dest.index, projectIds.length), 0, projectId);
    return {
      ...workspace,
      projectIds,
      collapsed: false,
      activeProjectId: workspace.activeProjectId ?? projectId,
    };
  });
  return { workspaces: workspacesNext, sidebar: stripped.sidebar };
}

/** Add a workspace at `index` in the top-level list, counted without it. */
export function insertWorkspace(
  workspaces: Workspace[],
  sidebar: SidebarRoot[],
  workspace: Workspace,
  index: number,
): Layout {
  const next = [...sidebar];
  next.splice(clamp(index, next.length), 0, {
    kind: "workspace",
    id: workspace.id,
  });
  return { workspaces: [...workspaces, workspace], sidebar: next };
}

/**
 * Dissolve a workspace: members become standalone roots in its place, in the
 * order they had inside the group. The projects themselves are untouched.
 */
export function dissolveWorkspace(
  workspaces: Workspace[],
  sidebar: SidebarRoot[],
  workspaceId: string,
): Layout {
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const nextWorkspaces = workspaces.filter((item) => item.id !== workspaceId);
  if (!workspace) return { workspaces: nextWorkspaces, sidebar };

  const members: SidebarRoot[] = workspace.projectIds.map((id) => ({
    kind: "project",
    id,
  }));
  const at = sidebar.findIndex(
    (item) => item.kind === "workspace" && item.id === workspaceId,
  );
  const nextSidebar = [...sidebar];
  if (at >= 0) nextSidebar.splice(at, 1, ...members);
  else nextSidebar.push(...members);
  return { workspaces: nextWorkspaces, sidebar: nextSidebar };
}

/** Reorder a top-level row. `index` is counted without the moved item. */
export function reorderRoot(
  sidebar: SidebarRoot[],
  item: SidebarRoot,
  index: number,
): SidebarRoot[] {
  return moveTo(
    sidebar,
    (entry) => entry.kind === item.kind && entry.id === item.id,
    index,
  );
}

export function shiftRoot(
  sidebar: SidebarRoot[],
  item: SidebarRoot,
  delta: -1 | 1,
): SidebarRoot[] {
  return shift(
    sidebar,
    (entry) => entry.kind === item.kind && entry.id === item.id,
    delta,
  );
}

export function shiftMember(
  workspaces: Workspace[],
  workspaceId: string,
  projectId: string,
  delta: -1 | 1,
): Workspace[] {
  return workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) return workspace;
    return {
      ...workspace,
      projectIds: shift(
        workspace.projectIds,
        (id) => id === projectId,
        delta,
      ),
    };
  });
}

export function rememberWorkspaceProject(
  workspaces: Workspace[],
  workspaceId: string,
  projectId: string,
): Workspace[] {
  return workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) return workspace;
    if (!workspace.projectIds.includes(projectId)) return workspace;
    if (workspace.activeProjectId === projectId) return workspace;
    return { ...workspace, activeProjectId: projectId };
  });
}

export function setWorkspaceCollapsed(
  workspaces: Workspace[],
  workspaceId: string,
  collapsed: boolean,
): Workspace[] {
  return workspaces.map((workspace) =>
    workspace.id === workspaceId ? { ...workspace, collapsed } : workspace,
  );
}

export function renameWorkspace(
  workspaces: Workspace[],
  workspaceId: string,
  name: string,
): Workspace[] {
  const clean = name.trim();
  if (!clean) return workspaces;
  return workspaces.map((workspace) =>
    workspace.id === workspaceId ? { ...workspace, name: clean } : workspace,
  );
}

/** Index of the top-level row that contains this project — itself, or its group. */
export function rootIndexOfProject(
  workspaces: Workspace[],
  sidebar: SidebarRoot[],
  projectId: string,
): number {
  const workspace = workspaceOf(workspaces, projectId);
  if (workspace) {
    return sidebar.findIndex(
      (item) => item.kind === "workspace" && item.id === workspace.id,
    );
  }
  return sidebar.findIndex(
    (item) => item.kind === "project" && item.id === projectId,
  );
}

export function emptyWorkspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    collapsed: false,
    projectIds: [],
    activeProjectId: null,
  };
}
