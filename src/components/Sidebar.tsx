/**
 * The sidebar: every project, its decks, and the terminals inside them.
 *
 * Three kinds of row, one grammar:
 *
 *  - **Click** goes there.
 *  - **Double-click** or **F2** renames it in place.
 *  - **Right-click**, the context-menu key, or the ⋯ that appears on hover opens
 *    everything else you can do to it. The menus are shared with the panes, so a
 *    terminal offers the same actions wherever you reach for it.
 *
 * Decks show up as small numbered group headers once a project has two of them.
 * With one, its terminals sit straight under the project, and nothing here
 * mentions decks until you make a second.
 *
 * **Exactly one row is ever filled.** Selecting a terminal makes its deck and
 * project current too, and filling all three stacked into one tall blob. So the
 * fill goes to the deepest thing that is actually current — the focused
 * terminal, else the active deck, else the project — and the rows above it say
 * "you are inside me" with weight and text colour instead. See `leafOf`.
 */

import { ChevronRight, Ellipsis, FolderPlus, Plus, X } from "lucide-react";

import { InlineRename } from "@/components/InlineRename";
import { StatusDot } from "@/components/StatusDot";
import {
  ContextMenuEntries,
  type MenuEntry,
} from "@/components/menu/MenuEntries";
import {
  deckMenu,
  paneMenu,
  pickProjectFolder,
  projectMenu,
  sidebarMenu,
} from "@/components/menu/actions";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { agentAccent } from "@/lib/tokens";
import { listPanes } from "@/lib/tree";
import { cn } from "@/lib/utils";
import type {
  Agent,
  AgentAccount,
  Deck,
  Pane,
  PaneStatus,
  Project,
} from "@/lib/types";
import {
  activeDeck,
  deckAttention,
  useKeel,
  type RenameTarget,
} from "@/state/store";

/** Left padding per level, added to the row's own 8px. */
const INDENT = [0, 14, 26];

/** Which row of the selected project carries the fill. */
type Leaf =
  | { kind: "project" }
  | { kind: "deck" }
  | { kind: "pane"; id: string };

/**
 * The deepest row that is actually current, and so the only one that gets a
 * fill. A collapsed project is its own leaf; an open one hands the fill down to
 * its focused terminal, or to the active deck when the decks are on screen and
 * nothing inside them has focus.
 */
function leafOf(project: Project, open: boolean, showDecks: boolean): Leaf {
  if (!open) return { kind: "project" };
  const deck = activeDeck(project);
  const focused = deck?.focused ?? null;
  if (deck && focused && listPanes(deck.tree).includes(focused)) {
    return { kind: "pane", id: focused };
  }
  return showDecks ? { kind: "deck" } : { kind: "project" };
}

export interface SidebarProps {
  activeProjectId: string | null;
  /**
   * Fired whenever a row moves you somewhere. The canvas can be covered by the
   * overview, and navigating from over here has to get you out from under it —
   * otherwise the row lights up, the deck really does change, and the click
   * still looks like it did nothing.
   */
  onNavigate: () => void;
}

type RowGroup = RenameTarget["kind"];

// Spelled out per group so Tailwind can see every class name.
const GROUP: Record<RowGroup, string> = {
  project: "group/project",
  deck: "group/deck",
  pane: "group/pane",
};
const SHOW_ON_HOVER: Record<RowGroup, string> = {
  project: "group-hover/project:flex group-focus-visible/project:flex",
  deck: "group-hover/deck:flex group-focus-visible/deck:flex",
  pane: "group-hover/pane:flex group-focus-visible/pane:flex",
};
const HIDE_ON_HOVER: Record<RowGroup, string> = {
  project: "group-hover/project:hidden group-focus-visible/project:hidden",
  deck: "group-hover/deck:hidden group-focus-visible/deck:hidden",
  pane: "group-hover/pane:hidden group-focus-visible/pane:hidden",
};

function useRenaming(kind: RowGroup, id: string): boolean {
  return useKeel(
    (state) =>
      state.renaming?.where === "sidebar" &&
      state.renaming.kind === kind &&
      state.renaming.id === id,
  );
}

function startRename(kind: RowGroup, id: string) {
  useKeel.getState().startRename({ kind, id, where: "sidebar" });
}

function stopRename() {
  useKeel.getState().stopRename();
}

/** Open a row's context menu from a button inside it, anchored under the button. */
function openMenuFrom(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left,
      clientY: rect.bottom + 2,
    }),
  );
}

function isControl(target: EventTarget): boolean {
  return target instanceof Element && target.closest("button, input") !== null;
}

export function Sidebar({ activeProjectId, onNavigate }: SidebarProps) {
  const agents = useKeel((state) => state.agents);
  const accounts = useKeel((state) => state.accounts);
  const projects = useKeel((state) => state.projects);
  const status = useKeel((state) => state.status);

  return (
    <aside className="k-glass flex w-[240px] shrink-0 flex-col border-r border-line">
      <div className="flex h-[34px] shrink-0 items-center justify-between pr-2">
        <h2 className="k-label">Projects</h2>
        <button
          type="button"
          title="Add a folder"
          aria-label="Add a folder"
          onClick={() => void pickProjectFolder()}
          className="k-icon-btn size-[24px]"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2 pt-0.5">
            {projects.length === 0 ? (
              <EmptyProjects />
            ) : (
              projects.map((project) => (
                <ProjectSection
                  key={project.id}
                  project={project}
                  agents={agents}
                  accounts={accounts}
                  status={status}
                  selected={project.id === activeProjectId}
                  onNavigate={onNavigate}
                />
              ))
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuEntries entries={sidebarMenu} />
        </ContextMenuContent>
      </ContextMenu>
    </aside>
  );
}

/**
 * An empty screen is an invitation to act, so this is one target rather than a
 * sentence with a button under it.
 */
function EmptyProjects() {
  return (
    <div className="px-[var(--keel-inset)] pt-1">
      <button
        type="button"
        onClick={() => void pickProjectFolder()}
        className="flex w-full flex-col items-start gap-1 rounded-[var(--keel-r-control)] border border-dashed border-line-strong px-3 py-3 text-left transition-colors hover:border-foreground/25 hover:bg-veil"
      >
        <span className="flex items-center gap-1.5 text-[13px] text-foreground">
          <FolderPlus className="size-3.5 text-dim" />
          Add a folder
        </span>
        <span className="text-[12px] leading-snug text-faint">
          Terminals are grouped by the project they run in.
        </span>
      </button>
    </div>
  );
}

/**
 * A row that behaves like one: focusable, activated by Enter or Space, renamed
 * by F2 or a double-click, and carrying its own context menu.
 */
function Row({
  group,
  menu,
  selected,
  onActivate,
  onRename,
  className,
  style,
  title,
  children,
}: {
  group: RowGroup;
  menu: () => MenuEntry[];
  selected: boolean;
  onActivate: () => void;
  onRename: () => void;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          data-selected={selected}
          title={title}
          style={style}
          className={cn("k-row", GROUP[group], className)}
          onClick={(event) => {
            if (!isControl(event.target)) onActivate();
          }}
          onDoubleClick={(event) => {
            if (!isControl(event.target)) onRename();
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onActivate();
            } else if (event.key === "F2") {
              event.preventDefault();
              onRename();
            } else if (
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              event.preventDefault();
              openMenuFrom(event.currentTarget);
            }
          }}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuEntries entries={menu} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Quick actions that slide in on hover, replacing the row's quiet detail. */
function RowActions({
  group,
  children,
}: {
  group: RowGroup;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("hidden shrink-0 items-center gap-px", SHOW_ON_HOVER[group])}>
      {children}
    </span>
  );
}

function RowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: (button: HTMLElement) => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-danger={danger ? "true" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        onClick(event.currentTarget);
      }}
      className="k-icon-btn size-[21px]"
    >
      {children}
    </button>
  );
}

function MoreButton() {
  return (
    <RowButton label="More actions" onClick={openMenuFrom}>
      <Ellipsis className="size-3.5" />
    </RowButton>
  );
}

/** A pane or deck tally. Mono and tabular because it is a number you compare. */
function Count({ value, className }: { value: number; className?: string }) {
  if (!value) return null;
  return (
    <span
      className={cn(
        "shrink-0 pr-1 font-mono text-[11px] tabular-nums text-faint",
        className,
      )}
    >
      {value}
    </span>
  );
}

interface TreeProps {
  agents: Agent[];
  accounts: AgentAccount[];
  status: Record<string, PaneStatus>;
  onNavigate: () => void;
}

function ProjectSection({
  project,
  selected,
  agents,
  accounts,
  status,
  onNavigate,
}: TreeProps & { project: Project; selected: boolean }) {
  const total = project.decks.reduce(
    (sum, deck) => sum + listPanes(deck.tree).length,
    0,
  );
  const showDecks = project.decks.length > 1;
  const expandable = total > 0 || showDecks;
  const open = expandable && !project.collapsed;
  const leaf = selected ? leafOf(project, open, showDecks) : null;
  const renaming = useRenaming("project", project.id);
  const tree = { agents, accounts, status, onNavigate };

  return (
    <div className="pt-0.5">
      <Row
        group="project"
        menu={() => projectMenu(project.id)}
        selected={leaf?.kind === "project"}
        title={project.path}
        onActivate={() => {
          useKeel.getState().selectProject(project.id);
          onNavigate();
        }}
        onRename={() => startRename("project", project.id)}
      >
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          disabled={!expandable}
          onClick={(event) => {
            event.stopPropagation();
            useKeel.getState().toggleCollapsed(project.id);
          }}
          className="-ml-1 grid size-4 shrink-0 place-items-center rounded-[3px] text-faint transition-colors hover:text-foreground disabled:opacity-0"
        >
          <ChevronRight
            className={cn(
              "size-3 transition-transform duration-150",
              open && "rotate-90",
            )}
          />
        </button>

        {renaming ? (
          <InlineRename
            value={project.name}
            onCommit={(name) => useKeel.getState().renameProject(project.id, name)}
            onDone={stopRename}
          />
        ) : (
          <>
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                selected ? "font-medium text-foreground" : "text-dim",
              )}
            >
              {project.name}
            </span>
            <Count value={total} className={HIDE_ON_HOVER.project} />
            <RowActions group="project">
              <RowButton
                label="Add terminals"
                onClick={() => {
                  const state = useKeel.getState();
                  state.selectProject(project.id);
                  state.setLauncher(true);
                  onNavigate();
                }}
              >
                <Plus className="size-3" />
              </RowButton>
              <MoreButton />
            </RowActions>
          </>
        )}
      </Row>

      {open ? (
        showDecks ? (
          project.decks.map((deck, index) => (
            <DeckGroup
              key={deck.id}
              project={project}
              deck={deck}
              index={index}
              leaf={leaf}
              {...tree}
            />
          ))
        ) : (
          <PaneRows
            project={project}
            deck={project.decks[0]}
            depth={1}
            leaf={leaf}
            {...tree}
          />
        )
      ) : null}
    </div>
  );
}

function DeckGroup({
  project,
  deck,
  index,
  leaf,
  ...tree
}: TreeProps & {
  project: Project;
  deck: Deck;
  index: number;
  leaf: Leaf | null;
}) {
  const active = deck.id === project.activeDeckId;
  const count = listPanes(deck.tree).length;
  const attention = deckAttention(deck, tree.status);
  const renaming = useRenaming("deck", deck.id);

  const addHere = () => {
    const state = useKeel.getState();
    state.selectProject(project.id);
    state.selectDeck(project.id, deck.id);
    state.setLauncher(true);
    tree.onNavigate();
  };

  return (
    <>
      <Row
        group="deck"
        menu={() => deckMenu(project.id, deck.id)}
        selected={active && leaf?.kind === "deck"}
        className="mt-1.5 h-[26px]"
        style={{ paddingLeft: 8 + INDENT[1] }}
        onActivate={() => {
          const state = useKeel.getState();
          state.selectProject(project.id);
          state.selectDeck(project.id, deck.id);
          tree.onNavigate();
        }}
        onRename={() => startRename("deck", deck.id)}
      >
        {/* Decks are numbered everywhere else in the app; number them here too. */}
        <span
          className={cn(
            "grid h-4 min-w-4 shrink-0 place-items-center rounded-[4px] px-1 font-mono text-[10px] tabular-nums transition-colors",
            active ? "bg-veil-3 text-foreground" : "bg-veil text-faint",
          )}
        >
          {index + 1}
        </span>

        {renaming ? (
          <InlineRename
            value={deck.name}
            className="h-5 text-[12px]"
            onCommit={(name) =>
              useKeel.getState().renameDeck(project.id, deck.id, name)
            }
            onDone={stopRename}
          />
        ) : (
          <>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[12px]",
                active ? "font-medium text-foreground" : "text-dim",
              )}
            >
              {deck.name}
            </span>
            {!active && attention ? <StatusDot status={attention} /> : null}
            <Count value={count} className={HIDE_ON_HOVER.deck} />
            <RowActions group="deck">
              <RowButton label="Add terminals to this deck" onClick={addHere}>
                <Plus className="size-3" />
              </RowButton>
              <MoreButton />
            </RowActions>
          </>
        )}
      </Row>

      {count === 0 ? (
        <button
          type="button"
          onClick={addHere}
          className="k-row gap-1.5 text-[12px] text-faint hover:text-dim"
          style={{ paddingLeft: 8 + INDENT[2] }}
        >
          <Plus className="size-3" />
          Add terminals
        </button>
      ) : (
        <PaneRows
          project={project}
          deck={deck}
          depth={2}
          leaf={active ? leaf : null}
          {...tree}
        />
      )}
    </>
  );
}

function PaneRows({
  project,
  deck,
  depth,
  leaf,
  agents,
  accounts,
  status,
  onNavigate,
}: TreeProps & {
  project: Project;
  deck: Deck;
  depth: number;
  leaf: Leaf | null;
}) {
  const active = deck.id === project.activeDeckId;

  return (
    <>
      {listPanes(deck.tree).map((paneId) => {
        const pane = deck.panes[paneId];
        if (!pane) return null;
        return (
          <PaneRow
            key={paneId}
            project={project}
            pane={pane}
            depth={depth}
            agent={agents.find((agent) => agent.id === pane.agentId) ?? null}
            account={
              accounts.find((account) => account.id === pane.accountId) ?? null
            }
            status={status[paneId] ?? "idle"}
            selected={leaf?.kind === "pane" && leaf.id === paneId}
            focused={active && deck.focused === paneId}
            onNavigate={onNavigate}
          />
        );
      })}
    </>
  );
}

function PaneRow({
  project,
  pane,
  depth,
  agent,
  account,
  status,
  selected,
  focused,
  onNavigate,
}: {
  project: Project;
  pane: Pane;
  depth: number;
  agent: Agent | null;
  account: AgentAccount | null;
  status: PaneStatus;
  selected: boolean;
  focused: boolean;
  onNavigate: () => void;
}) {
  const renaming = useRenaming("pane", pane.id);

  return (
    <Row
      group="pane"
      menu={() => paneMenu(project.id, pane.id, "sidebar")}
      selected={selected}
      title={pane.cwd ?? project.path}
      style={{ paddingLeft: 8 + (INDENT[depth] ?? INDENT[2]) }}
      onActivate={() => {
        // Reaching a terminal brings its project and deck with it.
        const state = useKeel.getState();
        state.selectProject(project.id);
        state.focusPane(project.id, pane.id);
        onNavigate();
      }}
      onRename={() => startRename("pane", pane.id)}
    >
      <StatusDot status={status} />
      <span
        className="w-[18px] shrink-0 font-mono text-[10px] font-medium"
        style={{ color: agentAccent(agent?.accent) }}
      >
        {agent?.short || "SH"}
      </span>

      {renaming ? (
        <InlineRename
          value={pane.title}
          onCommit={(title) =>
            useKeel.getState().renamePane(project.id, pane.id, title)
          }
          onDone={stopRename}
        />
      ) : (
        <>
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              focused ? "font-medium text-foreground" : "text-dim",
            )}
          >
            {pane.title}
          </span>
          {account ? (
            <span
              className={cn(
                "max-w-[64px] shrink-0 truncate pr-1 text-[11px] text-faint",
                HIDE_ON_HOVER.pane,
              )}
            >
              {account.name}
            </span>
          ) : null}
          <RowActions group="pane">
            <MoreButton />
            <RowButton
              label="Close terminal"
              danger
              onClick={() => useKeel.getState().closePane(project.id, pane.id)}
            >
              <X className="size-3" />
            </RowButton>
          </RowActions>
        </>
      )}
    </Row>
  );
}
