/**
 * Scope: which slice of the sidebar you are looking at.
 *
 * The old dock drew the whole four-level tree at once — every workspace, every
 * project inside it, every deck, every terminal — so three workspaces of real
 * work was several hundred rows deep and you navigated it by scrolling and
 * hoping. The fix is not a tidier tree. It is showing one workspace at a time.
 *
 * A scope is the top of the sidebar rather than a row inside it: pick
 * "Acme Platform" and the dock is Acme's projects and nothing else. Other
 * workspaces are one click away in the switcher instead of on screen competing
 * for the same 248px. That removes an entire level of nesting, and it bounds
 * the list — adding a tenth workspace does not make the ninth harder to read.
 *
 * Three kinds:
 *
 *  - `all`       every project, grouped under quiet workspace headings. The
 *                default before you have made a workspace, and the way back to
 *                a whole-machine view when you want one.
 *  - `workspace` one group's members.
 *  - `loose`     the projects that belong to no group. Only offered when there
 *                are some.
 *
 * Everything here is pure so it can be tested without React or the store.
 */

import { matchScore } from "./island.ts";
import { listPanes } from "./tree.ts";
import { repairSidebar, workspaceOf } from "./workspaces.ts";
import type { ProjectDestination } from "./workspaces.ts";
import type { Project, SidebarRoot, Workspace } from "./types.ts";

export type Scope =
  | { kind: "all" }
  | { kind: "loose" }
  | { kind: "workspace"; id: string };

export const ALL_SCOPE: Scope = { kind: "all" };
export const LOOSE_SCOPE: Scope = { kind: "loose" };

/** A stable string for storage and for React keys. */
export function scopeKey(scope: Scope): string {
  return scope.kind === "workspace" ? `workspace:${scope.id}` : scope.kind;
}

export function sameScope(a: Scope, b: Scope): boolean {
  return scopeKey(a) === scopeKey(b);
}

/** Read a scope back from storage, dropping one whose workspace is gone. */
export function parseScope(raw: string | null, workspaces: Workspace[]): Scope {
  if (raw === "all" || raw === null) return ALL_SCOPE;
  if (raw === "loose") return LOOSE_SCOPE;
  const id = raw.startsWith("workspace:") ? raw.slice("workspace:".length) : "";
  if (id && workspaces.some((workspace) => workspace.id === id)) {
    return { kind: "workspace", id };
  }
  return ALL_SCOPE;
}

/** The narrowest scope that holds this project: its group, else the loose list. */
export function scopeOf(workspaces: Workspace[], projectId: string): Scope {
  const workspace = workspaceOf(workspaces, projectId);
  return workspace ? { kind: "workspace", id: workspace.id } : LOOSE_SCOPE;
}

/** Whether a project is on screen under this scope. */
export function scopeHolds(
  workspaces: Workspace[],
  scope: Scope,
  projectId: string,
): boolean {
  if (scope.kind === "all") return true;
  const workspace = workspaceOf(workspaces, projectId);
  if (scope.kind === "loose") return workspace === null;
  return workspace?.id === scope.id;
}

// ---- The switcher's menu ----------------------------------------------------

export interface ScopeOption {
  scope: Scope;
  key: string;
  name: string;
  /** Projects it would show. */
  count: number;
  /** Terminals across those projects. */
  terminals: number;
}

function terminalsIn(project: Project): number {
  return project.decks.reduce((sum, deck) => sum + listPanes(deck.tree).length, 0);
}

/**
 * What the switcher offers, in sidebar order: every workspace, then the loose
 * projects if there are any, then "All projects" when there is more than one
 * thing to switch between.
 */
export function scopeOptions(
  projects: Project[],
  workspaces: Workspace[],
  sidebar: SidebarRoot[],
): ScopeOption[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const roots = repairSidebar(projects, workspaces, sidebar);
  const options: ScopeOption[] = [];

  for (const root of roots) {
    if (root.kind !== "workspace") continue;
    const workspace = workspaces.find((item) => item.id === root.id);
    if (!workspace) continue;
    const members = workspace.projectIds
      .map((id) => byId.get(id))
      .filter((item): item is Project => Boolean(item));
    options.push({
      scope: { kind: "workspace", id: workspace.id },
      key: `workspace:${workspace.id}`,
      name: workspace.name,
      count: members.length,
      terminals: members.reduce((sum, project) => sum + terminalsIn(project), 0),
    });
  }

  const loose = roots
    .filter((root) => root.kind === "project")
    .map((root) => byId.get(root.id))
    .filter((item): item is Project => Boolean(item));
  if (loose.length > 0 && options.length > 0) {
    options.push({
      scope: LOOSE_SCOPE,
      key: "loose",
      name: "Ungrouped",
      count: loose.length,
      terminals: loose.reduce((sum, project) => sum + terminalsIn(project), 0),
    });
  }

  options.unshift({
    scope: ALL_SCOPE,
    key: "all",
    name: "All projects",
    count: projects.length,
    terminals: projects.reduce((sum, project) => sum + terminalsIn(project), 0),
  });

  return options;
}

/** The scope's own name, for the switcher button. */
export function scopeName(scope: Scope, workspaces: Workspace[]): string {
  if (scope.kind === "all") return "All projects";
  if (scope.kind === "loose") return "Ungrouped";
  const workspace = workspaces.find((item) => item.id === scope.id);
  return workspace?.name ?? "All projects";
}

// ---- The list itself --------------------------------------------------------

/**
 * A project as the panel draws it. `groupName` is set only when the scope shows
 * more than one group, so a heading appears in "All projects" and nowhere else.
 */
export interface ScopedProject {
  project: Project;
  groupId: string | null;
  groupName: string | null;
}

/**
 * The projects this scope shows.
 *
 * A workspace or the loose list is already flat and keeps its saved order.
 * "All projects" is the one that has to arrange itself: it draws each group as a
 * captioned section and then the ungrouped projects as one final section, rather
 * than interleaving them the way the saved top-level list happens to. Saved
 * order puts a loose project before the groups as readily as after, and honouring
 * that literally captions "Ungrouped" two and three times down a single dock —
 * which is exactly the kind of thing that made the old sidebar hard to read.
 * Relative order inside each section is still the saved one, so dragging behaves.
 */
export function projectsInScope(
  projects: Project[],
  workspaces: Workspace[],
  sidebar: SidebarRoot[],
  scope: Scope,
): ScopedProject[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const roots = repairSidebar(projects, workspaces, sidebar);
  const result: ScopedProject[] = [];

  if (scope.kind === "workspace") {
    const workspace = workspaces.find((item) => item.id === scope.id);
    if (!workspace) return [];
    for (const id of workspace.projectIds) {
      const project = byId.get(id);
      if (project) result.push({ project, groupId: null, groupName: null });
    }
    return result;
  }

  const loose: ScopedProject[] = [];
  for (const root of roots) {
    if (root.kind === "project") {
      const project = byId.get(root.id);
      if (project) loose.push({ project, groupId: null, groupName: null });
      continue;
    }
    if (scope.kind === "loose") continue;
    const workspace = workspaces.find((item) => item.id === root.id);
    if (!workspace) continue;
    for (const id of workspace.projectIds) {
      const project = byId.get(id);
      if (!project) continue;
      result.push({
        project,
        groupId: workspace.id,
        groupName: workspace.name,
      });
    }
  }

  return [...result, ...loose];
}

// ---- Filtering --------------------------------------------------------------

/**
 * A project that survived the filter. `panes` is null when the project matched
 * on its own name — it then shows its whole tree — and otherwise lists exactly
 * the terminals that matched.
 */
export interface FilteredProject extends ScopedProject {
  panes: string[] | null;
}

function paneMatches(project: Project, query: string): string[] {
  const hits: string[] = [];
  for (const deck of project.decks) {
    for (const paneId of listPanes(deck.tree)) {
      const pane = deck.panes[paneId];
      if (!pane) continue;
      if (matchScore(pane.title, query) !== null) hits.push(paneId);
    }
  }
  return hits;
}

/**
 * Narrow the list to what names `query`.
 *
 * A project survives if its own name matches — then it keeps every terminal, so
 * searching a project shows you the project — or if any terminal inside it
 * does, in which case only those terminals are drawn. An empty query is not a
 * filter and passes everything through untouched.
 */
export function filterProjects(
  scoped: ScopedProject[],
  query: string,
): FilteredProject[] {
  if (!query.trim()) {
    return scoped.map((entry) => ({ ...entry, panes: null }));
  }
  const result: FilteredProject[] = [];
  for (const entry of scoped) {
    if (matchScore(entry.project.name, query) !== null) {
      result.push({ ...entry, panes: null });
      continue;
    }
    const panes = paneMatches(entry.project, query);
    if (panes.length > 0) result.push({ ...entry, panes });
  }
  return result;
}

/**
 * How many projects elsewhere would match, so the panel can offer to widen the
 * search instead of telling you there is nothing when there is.
 */
export function matchesOutsideScope(
  projects: Project[],
  workspaces: Workspace[],
  scope: Scope,
  query: string,
): number {
  if (!query.trim() || scope.kind === "all") return 0;
  let count = 0;
  for (const project of projects) {
    if (scopeHolds(workspaces, scope, project.id)) continue;
    if (
      matchScore(project.name, query) !== null ||
      paneMatches(project, query).length > 0
    ) {
      count += 1;
    }
  }
  return count;
}

// ---- Reordering -------------------------------------------------------------

/**
 * Where a project dropped on another project should land.
 *
 * The target's container decides: dropping onto a member of a workspace joins
 * that workspace at the member's place, dropping onto a loose project puts it
 * back on the top level. So in "All projects" a drag between two headings both
 * reorders and regroups, and in a workspace scope it can only reorder, which is
 * the only thing that makes sense there.
 *
 * Indices are counted with the moved project already taken out, matching
 * `placeProject`.
 */
export function projectDropTarget(
  workspaces: Workspace[],
  sidebar: SidebarRoot[],
  moving: string,
  onto: string,
  after: boolean,
): ProjectDestination | null {
  if (moving === onto) return null;
  const step = after ? 1 : 0;
  const group = workspaceOf(workspaces, onto);

  if (group) {
    const rest = group.projectIds.filter((id) => id !== moving);
    const at = rest.indexOf(onto);
    if (at < 0) return null;
    return { kind: "member", workspaceId: group.id, index: at + step };
  }

  const rest = sidebar.filter(
    (entry) => !(entry.kind === "project" && entry.id === moving),
  );
  const at = rest.findIndex(
    (entry) => entry.kind === "project" && entry.id === onto,
  );
  if (at < 0) return null;
  return { kind: "root", index: at + step };
}

/** Where a project dropped on a workspace heading lands: the end of that group. */
export function groupDropTarget(
  workspaces: Workspace[],
  moving: string,
  workspaceId: string,
): ProjectDestination | null {
  const workspace = workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return null;
  const rest = workspace.projectIds.filter((id) => id !== moving);
  return { kind: "member", workspaceId, index: rest.length };
}
