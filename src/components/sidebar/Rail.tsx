/**
 * The folded dock.
 *
 * 52 pixels is room for one idea, and with a scope at the top of the panel the
 * rail finally has an obvious one: the scope's own mark, a hairline, then a
 * tile per project in it. Where the old rail mixed workspaces and loose
 * projects into a single column of monograms you had to decode, this one reads
 * top to bottom as "you are in Acme; these are Acme's projects".
 *
 * The scope tile is a menu, so switching workspaces never needs the panel back.
 * Every tile keeps the hover name, the status badge, and the same context menu
 * it has when the dock is open.
 */

import type { CSSProperties } from "react";
import { Check, FolderPlus, Layers, Plus } from "lucide-react";

import { RailTip, RailTipProvider } from "@/components/Dock";
import { WorkspaceGlyph } from "@/components/WorkspaceMark";
import { pickProjectFolder, projectMenu } from "@/components/menu/actions";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ContextMenuEntries,
} from "@/components/menu/MenuEntries";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { monogram } from "@/lib/monogram";
import {
  sameScope,
  scopeName,
  type ScopedProject,
  type Scope,
  type ScopeOption,
} from "@/lib/sidebarScope";
import { listPanes } from "@/lib/tree";
import { cn } from "@/lib/utils";
import type { PaneStatus, Workspace } from "@/lib/types";
import { useKeel, type Attention } from "@/state/store";
import { projectAttention } from "./ProjectList";

const BADGE: Record<Attention, string> = {
  working: "var(--keel-working)",
  done: "var(--keel-done)",
};

function tileDelay(index: number): CSSProperties {
  return { ["--i" as string]: index };
}

export function Rail({
  hidden,
  scope,
  options,
  workspaces,
  entries,
  status,
  activeProjectId,
  onScope,
  onNavigate,
}: {
  hidden: boolean;
  scope: Scope;
  options: ScopeOption[];
  workspaces: Workspace[];
  entries: ScopedProject[];
  status: Record<string, PaneStatus>;
  activeProjectId: string | null;
  onScope: (next: Scope) => void;
  onNavigate: () => void;
}) {
  const workspace =
    scope.kind === "workspace"
      ? (workspaces.find((item) => item.id === scope.id) ?? null)
      : null;

  return (
    <RailTipProvider>
      <nav aria-label="Projects" className="k-dock-rail" inert={hidden}>
        {/* The fold toggle's slot, level with the panel's header. */}
        <div className="h-[44px] w-full shrink-0" />

        <DropdownMenu>
          <RailTip label={scopeName(scope, workspaces)} detail="Switch">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Switch workspace"
                className="k-rail-tile k-rail-scope shrink-0"
              >
                {workspace ? (
                  monogram(workspace.name)
                ) : scope.kind === "all" ? (
                  <Layers className="size-4" />
                ) : (
                  <WorkspaceGlyph className="size-4" />
                )}
              </button>
            </DropdownMenuTrigger>
          </RailTip>
          <DropdownMenuContent side="right" align="start" className="w-[200px]">
            <DropdownMenuLabel>Show</DropdownMenuLabel>
            {options.map((option) => (
              <DropdownMenuItem
                key={option.key}
                onSelect={() => onScope(option.scope)}
              >
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                <span className="text-[11px] tabular-nums text-faint">
                  {option.count}
                </span>
                <Check
                  className={cn(
                    "size-3.5 shrink-0",
                    sameScope(option.scope, scope) ? "opacity-100" : "opacity-0",
                  )}
                />
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                void pickProjectFolder(
                  scope.kind === "workspace" ? scope.id : undefined,
                )
              }
            >
              <FolderPlus />
              Add a folder…
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                const id = useKeel.getState().addWorkspace();
                onScope({ kind: "workspace", id });
              }}
            >
              <WorkspaceGlyph />
              New workspace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <span aria-hidden className="k-rail-rule" />

        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden pb-2 [scrollbar-width:none]">
          {entries.map((entry, index) => {
            const project = entry.project;
            const total = project.decks.reduce(
              (sum, deck) => sum + listPanes(deck.tree).length,
              0,
            );
            const attention = projectAttention(project, status);
            return (
              <ContextMenu key={project.id}>
                <RailTip
                  label={project.name}
                  detail={
                    total
                      ? `${total} ${total === 1 ? "terminal" : "terminals"}`
                      : undefined
                  }
                >
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={project.name}
                      aria-current={
                        project.id === activeProjectId ? "page" : undefined
                      }
                      data-selected={project.id === activeProjectId}
                      style={tileDelay(index)}
                      className="k-rail-tile shrink-0"
                      onClick={() => {
                        useKeel.getState().selectProject(project.id);
                        onNavigate();
                      }}
                    >
                      {monogram(project.name)}
                      {attention ? (
                        <span
                          aria-hidden
                          className="k-rail-badge"
                          style={{ background: BADGE[attention] }}
                        />
                      ) : null}
                    </button>
                  </ContextMenuTrigger>
                </RailTip>
                <ContextMenuContent>
                  <ContextMenuEntries entries={() => projectMenu(project.id)} />
                </ContextMenuContent>
              </ContextMenu>
            );
          })}

          <RailTip label="Add a folder">
            <button
              type="button"
              aria-label="Add a folder"
              onClick={() =>
                void pickProjectFolder(
                  scope.kind === "workspace" ? scope.id : undefined,
                )
              }
              style={tileDelay(entries.length)}
              className="k-rail-tile shrink-0 text-faint"
            >
              <Plus className="size-4" />
            </button>
          </RailTip>
        </div>
      </nav>
    </RailTipProvider>
  );
}
