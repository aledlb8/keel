/**
 * The projects dock.
 *
 * It used to draw the whole four-level tree at once — every workspace, every
 * project in it, every deck, every terminal — which is fine with one project
 * and unusable with twelve. The list simply got longer than the window and
 * there was nothing in it to hold on to.
 *
 * So the dock now has a **scope**: one workspace on screen at a time, named at
 * the top and swapped from there, with the rest one click away instead of
 * underfoot (see `lib/sidebarScope.ts`). That takes the tree from four levels to
 * three and, more importantly, makes the height of the dock a function of one
 * workspace rather than of all of them.
 *
 * Under the switcher sit the projects in scope, each opening to its decks and
 * terminals. See `ProjectList.tsx`. What is waiting on you is said by the
 * island in the titlebar rather than by a banner up here.
 *
 * The scope follows you. Jump to a terminal from the palette, a notification or
 * a shortcut and the dock re-scopes to wherever that project lives, so the row
 * you landed on is always one you can see.
 */

import { useEffect, useRef, useState } from "react";
import { SearchX } from "lucide-react";

import { DockNotice, DockToggle } from "@/components/Dock";
import { sidebarMenu } from "@/components/menu/actions";
import {
  ContextMenuEntries,
} from "@/components/menu/MenuEntries";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ALL_SCOPE,
  filterProjects,
  matchesOutsideScope,
  parseScope,
  projectsInScope,
  sameScope,
  scopeHolds,
  scopeKey,
  scopeOf,
  scopeOptions,
  type Scope,
} from "@/lib/sidebarScope";
import { useKeel } from "@/state/store";
import { EmptyScope, ProjectList } from "./ProjectList";
import { Rail } from "./Rail";
import { ScopeBar } from "./ScopeBar";
import { SortProvider } from "./dnd";

const SCOPE_KEY = "keel.scope";

export interface SidebarProps {
  activeProjectId: string | null;
  /** Folded down to the rail. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /**
   * Fired whenever a row moves you somewhere. The canvas can be covered by the
   * overview, and navigating from over here has to get you out from under it —
   * otherwise the row lights up, the deck really does change, and the click
   * still looks like it did nothing.
   */
  onNavigate: () => void;
}

export function Sidebar({
  activeProjectId,
  collapsed,
  onToggleCollapsed,
  onNavigate,
}: SidebarProps) {
  const agents = useKeel((state) => state.agents);
  const accounts = useKeel((state) => state.accounts);
  const projects = useKeel((state) => state.projects);
  const workspaces = useKeel((state) => state.workspaces);
  const sidebar = useKeel((state) => state.sidebar);
  const status = useKeel((state) => state.status);

  const [scope, setScope] = useState<Scope>(() => {
    try {
      return parseScope(localStorage.getItem(SCOPE_KEY), []);
    } catch {
      return ALL_SCOPE;
    }
  });
  const [query, setQuery] = useState("");

  /*
   * Saved before the workspaces have loaded, so the stored id cannot be checked
   * against them until they arrive. Re-read it once they have, then leave it
   * alone — and only take it if it actually holds the project being restored
   * alongside it, or the dock would open pointed away from the work.
   */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || workspaces.length === 0) return;
    restored.current = true;
    try {
      const saved = parseScope(localStorage.getItem(SCOPE_KEY), workspaces);
      setScope((previous) => {
        if (!sameScope(previous, ALL_SCOPE)) return previous;
        if (!activeProjectId) return saved;
        return scopeHolds(workspaces, saved, activeProjectId)
          ? saved
          : scopeOf(workspaces, activeProjectId);
      });
    } catch {
      // Storage unavailable: the scope just starts at all projects.
    }
  }, [workspaces, activeProjectId]);

  useEffect(() => {
    try {
      localStorage.setItem(SCOPE_KEY, scopeKey(scope));
    } catch {
      // Storage unavailable: the choice lasts for this session.
    }
  }, [scope]);

  /*
   * Follow the selection. You can reach a project from the palette, a
   * notification, a shortcut or the status bar, and if the dock stayed pointed
   * somewhere else you would be working in a project the sidebar denies exists.
   * Keyed on the project rather than on the scope, so browsing another
   * workspace without going into it still sticks.
   */
  useEffect(() => {
    if (!activeProjectId) return;
    setScope((previous) => {
      const workspaces = useKeel.getState().workspaces;
      if (scopeHolds(workspaces, previous, activeProjectId)) return previous;
      return scopeOf(workspaces, activeProjectId);
    });
  }, [activeProjectId]);

  // A scope whose workspace was dissolved elsewhere has nothing left to show.
  useEffect(() => {
    if (scope.kind !== "workspace") return;
    if (workspaces.some((item) => item.id === scope.id)) return;
    setScope(ALL_SCOPE);
  }, [scope, workspaces]);

  const options = scopeOptions(projects, workspaces, sidebar);
  const scoped = projectsInScope(projects, workspaces, sidebar, scope);
  const filtering = query.trim().length > 0;
  const entries = filterProjects(scoped, query);
  const elsewhere = matchesOutsideScope(projects, workspaces, scope, query);
  const list = {
    agents,
    accounts,
    status,
    activeProjectId,
    onNavigate,
  };

  return (
    <aside
      data-side="left"
      data-collapsed={collapsed}
      aria-label="Projects"
      className="k-dock"
    >
      <DockToggle
        side="left"
        collapsed={collapsed}
        what="sidebar"
        onToggle={onToggleCollapsed}
      />

      {/* Both layers stay mounted so folding is a crossfade, never a remount.
          Whichever is hidden is inert: no focus, no hover, no tooltips. */}
      <div className="k-dock-panel" inert={collapsed}>
        <ScopeBar
          scope={scope}
          options={options}
          workspaces={workspaces}
          query={query}
          onScope={setScope}
          onQuery={setQuery}
        />

        <SortProvider>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="min-h-0 flex-1 overflow-y-auto pb-2">
                {entries.length > 0 ? (
                  <ProjectList
                    entries={entries}
                    filtering={filtering}
                    showGroups={scope.kind === "all" && workspaces.length > 0}
                    {...list}
                  />
                ) : filtering ? (
                  <DockNotice
                    icon={SearchX}
                    title="No match"
                    {...(elsewhere > 0
                      ? {}
                      : { detail: "Nothing here is called that." })}
                    className="pt-8"
                  >
                    {elsewhere > 0 ? (
                      <button
                        type="button"
                        onClick={() => setScope(ALL_SCOPE)}
                        className="k-link mt-3"
                      >
                        {elsewhere}{" "}
                        {elsewhere === 1 ? "match" : "matches"} in other
                        workspaces
                      </button>
                    ) : null}
                  </DockNotice>
                ) : (
                  <EmptyScope
                    workspaceId={scope.kind === "workspace" ? scope.id : null}
                  />
                )}

                {/* Found here, but there is more elsewhere. Say so quietly
                    rather than letting the scope hide it in silence. */}
                {filtering && entries.length > 0 && elsewhere > 0 ? (
                  <button
                    type="button"
                    onClick={() => setScope(ALL_SCOPE)}
                    className="k-elsewhere"
                  >
                    {elsewhere} more in other workspaces
                  </button>
                ) : null}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuEntries entries={sidebarMenu} />
            </ContextMenuContent>
          </ContextMenu>
        </SortProvider>
      </div>

      <Rail
        hidden={!collapsed}
        scope={scope}
        options={options}
        workspaces={workspaces}
        entries={scoped}
        status={status}
        activeProjectId={activeProjectId}
        onScope={setScope}
        onNavigate={onNavigate}
      />
    </aside>
  );
}
