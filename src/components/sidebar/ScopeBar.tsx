/**
 * The top of the dock: where you are, and a way to find anything.
 *
 * Two rows, answering different questions. The switcher names the slice of your
 * work currently on screen and swaps it; the field narrows that slice to
 * whatever you type. Everything that used to crowd this header — a title that
 * never changed, a pair of unlabelled glyph buttons — has moved into the
 * switcher's menu, where it is named in words.
 */

import { useRef } from "react";
import {
  Check,
  ChevronsUpDown,
  FolderPlus,
  Layers,
  Pencil,
  Search,
  Ungroup,
  X,
} from "lucide-react";

import { InlineRename } from "@/components/InlineRename";
import { WorkspaceGlyph, WorkspaceMark } from "@/components/WorkspaceMark";
import { ContextMenuEntries } from "@/components/menu/MenuEntries";
import { pickProjectFolder, workspaceMenu } from "@/components/menu/actions";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { withShortcut } from "@/lib/keymap";
import {
  sameScope,
  scopeName,
  type Scope,
  type ScopeOption,
} from "@/lib/sidebarScope";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/lib/types";
import { useKeel } from "@/state/store";
import { stopRename, useRenaming } from "./rows";

/** The mark for a scope: a group's initials, or the generic grouped glyph. */
function ScopeMark({
  scope,
  workspaces,
  size = 18,
}: {
  scope: Scope;
  workspaces: Workspace[];
  size?: number;
}) {
  if (scope.kind === "workspace") {
    const workspace = workspaces.find((item) => item.id === scope.id);
    if (workspace) {
      return <WorkspaceMark name={workspace.name} size={size} current />;
    }
  }
  const Glyph = scope.kind === "all" ? Layers : WorkspaceGlyph;
  return (
    <span
      aria-hidden
      className="k-workspace-mark"
      style={{ width: size, height: size }}
    >
      <Glyph style={{ width: size * 0.62, height: size * 0.62 }} />
    </span>
  );
}

interface SwitcherProps {
  scope: Scope;
  options: ScopeOption[];
  workspaces: Workspace[];
  onScope: (next: Scope) => void;
}

/**
 * The switcher itself. Its menu carries the two things that make a new slice —
 * a folder and a group — and, when the slice is a group, everything you can do
 * to that group, since it no longer has a row of its own to right-click.
 */
function Switcher({ scope, options, workspaces, onScope }: SwitcherProps) {
  const current = options.find((option) => sameScope(option.scope, scope));
  const workspaceId = scope.kind === "workspace" ? scope.id : null;

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="k-scope" aria-label="Switch workspace">
          <ScopeMark scope={scope} workspaces={workspaces} />
          <span className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-foreground">
            {scopeName(scope, workspaces)}
          </span>
          {current?.count ? (
            <span className="k-count">{current.count}</span>
          ) : null}
          <ChevronsUpDown className="size-3.5 shrink-0 text-faint" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-[232px]">
        <DropdownMenuLabel>Show</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.key}
            onSelect={() => onScope(option.scope)}
            className="gap-2"
          >
            <ScopeMark scope={option.scope} workspaces={workspaces} size={16} />
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
          onSelect={() => void pickProjectFolder(workspaceId ?? undefined)}
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

        {workspaceId ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                useKeel.getState().startRename({
                  kind: "workspace",
                  id: workspaceId,
                  where: "sidebar",
                })
              }
            >
              <Pencil />
              Rename workspace
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                useKeel.getState().dissolveWorkspace(workspaceId);
                onScope({ kind: "all" });
              }}
            >
              <Ungroup />
              Ungroup workspace
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (!workspaceId) return <span className="min-w-0 flex-1">{menu}</span>;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span className="min-w-0 flex-1">{menu}</span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuEntries entries={() => workspaceMenu(workspaceId)} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function ScopeBar({
  scope,
  options,
  workspaces,
  query,
  onScope,
  onQuery,
}: SwitcherProps & {
  query: string;
  onQuery: (next: string) => void;
}) {
  const field = useRef<HTMLInputElement | null>(null);
  // Renaming the group you are inside happens here, because here is the only
  // place its name is written when it is the scope rather than a row.
  const renaming = useRenaming(
    "workspace",
    scope.kind === "workspace" ? scope.id : "",
  );

  return (
    <div className="shrink-0 px-[var(--keel-inset)] pb-1.5">
      {/* Right padding leaves the fold toggle its own slot. */}
      <div className="flex h-[44px] items-center pr-[32px]">
        {renaming && scope.kind === "workspace" ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 pl-[7px]">
            <WorkspaceMark
              name={scopeName(scope, workspaces)}
              size={18}
              current
            />
            <InlineRename
              value={scopeName(scope, workspaces)}
              onCommit={(name) =>
                useKeel.getState().renameWorkspace(scope.id, name)
              }
              onDone={stopRename}
            />
          </span>
        ) : (
          <Switcher
            scope={scope}
            options={options}
            workspaces={workspaces}
            onScope={onScope}
          />
        )}
      </div>

      <div className="k-filter">
        <Search aria-hidden className="size-3.5 shrink-0 text-faint" />
        <input
          ref={field}
          value={query}
          spellCheck={false}
          data-sidebar-filter
          placeholder={withShortcut("Filter", "filterSidebar")}
          aria-label="Filter projects and terminals"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              if (query) onQuery("");
              else event.currentTarget.blur();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-faint"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => {
              onQuery("");
              field.current?.focus();
            }}
            className="k-icon-btn size-[18px]"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
