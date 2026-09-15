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
 *  - **Drag** puts it somewhere else. Projects reorder among projects, decks
 *    among the decks of their project, and terminals anywhere inside their
 *    project — between other terminals, onto a deck, or into an empty one.
 *
 * Decks show up as small numbered group headers once a project has two of them.
 * With one, its terminals sit straight under the project, and nothing here
 * mentions decks until you make a second.
 *
 * Every project has the same shape, empty or not: a chevron, and when it is open
 * at least one row under it. An empty project shows an "Add terminals" row where
 * its terminals would be, so it never reads as a different kind of thing.
 *
 * **Exactly one row is ever filled.** Selecting a terminal makes its deck and
 * project current too, and filling all three stacked into one tall blob. So the
 * fill goes to the deepest thing that is actually current — the focused
 * terminal, else the active deck, else the project — and the rows above it say
 * "you are inside me" with weight and text colour instead. See `leafOf`.
 *
 * **Folded, it is a rail.** One toggle rides the sidebar's right edge; folding
 * narrows the band to a column of project monograms carrying the same hover and
 * selection states, a status badge, and the same context menu. See `SidebarRail`.
 */

import {
  createContext,
  useContext,
  useState,
  type CSSProperties,
  type Dispatch,
  type DragEvent,
  type HTMLAttributes,
  type ReactNode,
  type SetStateAction,
} from "react";
import { ChevronRight, Ellipsis, FolderPlus, Plus, X } from "lucide-react";

import { AgentMark } from "@/components/AgentMark";
import { DockToggle, RailTip, RailTipProvider } from "@/components/Dock";
import { InlineRename } from "@/components/InlineRename";
import { FileIcon } from "@/components/inspector/FileIcon";
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
import { bindingFor, matchesBinding } from "@/lib/keymap";
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
  type Attention,
  type RenameTarget,
} from "@/state/store";
import { useWorkspace } from "@/state/workspace";

/**
 * Left padding per level, added to the row's own 8px. The third level leaves
 * room for the guide line under its deck's number badge.
 */
const INDENT = [0, 14, 32];

/**
 * Where a group's guide line runs, from the dock's inner edge: under the
 * project's chevron for terminals straight under a project, under the deck's
 * number badge for terminals in a deck.
 */
const GUIDE = { project: 18, deck: 36 };

function guideAt(x: number): CSSProperties {
  return { ["--guide" as string]: `${x}px` };
}

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

// ---- Drag and drop ---------------------------------------------------------

/** The thing being carried. */
type DragItem =
  | { kind: "project"; projectId: string }
  | { kind: "deck"; projectId: string; deckId: string }
  | { kind: "pane"; projectId: string; deckId: string; paneId: string };

/**
 * A row that can receive a drop. A project row carries its only deck's id when
 * its terminals sit straight under it, so a terminal can be dropped onto it.
 */
type DropSpot =
  | { kind: "project"; projectId: string; deckId: string | null }
  | { kind: "deck"; projectId: string; deckId: string }
  | { kind: "pane"; projectId: string; deckId: string; paneId: string }
  | { kind: "empty"; projectId: string; deckId: string };

type Edge = "before" | "after" | "inside";

interface SortState {
  item: DragItem | null;
  over: { key: string; edge: Edge } | null;
}

const SortContext = createContext<{
  state: SortState;
  setState: Dispatch<SetStateAction<SortState>>;
} | null>(null);

const IDLE: SortState = { item: null, over: null };

function spotKey(spot: DropSpot): string {
  switch (spot.kind) {
    case "project":
      return `project:${spot.projectId}`;
    case "deck":
      return `deck:${spot.deckId}`;
    case "pane":
      return `pane:${spot.paneId}`;
    case "empty":
      return `empty:${spot.deckId}`;
  }
}

function sameThing(item: DragItem, spot: DropSpot): boolean {
  if (item.kind === "project") {
    return spot.kind === "project" && spot.projectId === item.projectId;
  }
  if (item.kind === "deck") {
    return spot.kind === "deck" && spot.deckId === item.deckId;
  }
  return spot.kind === "pane" && spot.paneId === item.paneId;
}

/** Where `item` would land on `spot`, or null if it cannot go there. */
function edgeFor(
  item: DragItem,
  spot: DropSpot,
  event: DragEvent<HTMLElement>,
): Edge | null {
  if (sameThing(item, spot)) return null;
  const rect = event.currentTarget.getBoundingClientRect();
  const half: Edge =
    event.clientY < rect.top + rect.height / 2 ? "before" : "after";

  if (item.kind === "project") return spot.kind === "project" ? half : null;
  // Decks and terminals never leave their project.
  if (spot.projectId !== item.projectId) return null;
  if (item.kind === "deck") return spot.kind === "deck" ? half : null;

  switch (spot.kind) {
    case "pane":
      return half;
    case "deck":
    case "empty":
      return "inside";
    case "project":
      return spot.deckId ? "inside" : null;
  }
}

function commitDrop(item: DragItem, spot: DropSpot, edge: Edge) {
  const state = useKeel.getState();
  const after = edge === "after" ? 1 : 0;

  if (item.kind === "project") {
    const rest = state.projects.filter((p) => p.id !== item.projectId);
    const at = rest.findIndex((p) => p.id === spot.projectId);
    if (at >= 0) state.reorderProject(item.projectId, at + after);
    return;
  }

  const project = state.projects.find((p) => p.id === item.projectId);
  if (!project) return;

  if (item.kind === "deck") {
    if (spot.kind !== "deck") return;
    const rest = project.decks.filter((deck) => deck.id !== item.deckId);
    const at = rest.findIndex((deck) => deck.id === spot.deckId);
    if (at >= 0) state.reorderDeck(project.id, item.deckId, at + after);
    return;
  }

  const deck = project.decks.find((entry) => entry.id === spot.deckId);
  if (!deck) return;
  const rest = listPanes(deck.tree).filter((id) => id !== item.paneId);
  let index = rest.length;
  if (spot.kind === "pane") {
    const at = rest.indexOf(spot.paneId);
    if (at >= 0) index = at + after;
  }
  state.placePane(project.id, item.paneId, deck.id, index);
}

type SortableProps = HTMLAttributes<HTMLElement> & {
  "data-drop"?: Edge;
  "data-dragging"?: "true";
};

/**
 * Wire a row into the sidebar's drag and drop. `item` is what dragging this row
 * picks up; pass null for rows that only receive drops, or while renaming.
 */
function useSortable(spot: DropSpot, item: DragItem | null): SortableProps {
  const context = useContext(SortContext);
  if (!context) return {};
  const { state, setState } = context;
  const key = spotKey(spot);

  return {
    draggable: item ? true : undefined,
    "data-dragging":
      item && state.item && sameThing(state.item, spot) ? "true" : undefined,
    "data-drop": state.over?.key === key ? state.over.edge : undefined,
    onDragStart: (event) => {
      if (!item) return;
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/keel-sidebar", key);
      setState({ item, over: null });
    },
    onDragEnd: () => setState(IDLE),
    onDragOver: (event) => {
      if (!state.item) return;
      const edge = edgeFor(state.item, spot, event);
      if (!edge) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      if (state.over?.key !== key || state.over.edge !== edge) {
        setState((previous) => ({ ...previous, over: { key, edge } }));
      }
    },
    onDragLeave: (event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
        return;
      }
      setState((previous) =>
        previous.over?.key === key ? { ...previous, over: null } : previous,
      );
    },
    onDrop: (event) => {
      const carried = state.item;
      setState(IDLE);
      if (!carried) return;
      const edge = edgeFor(carried, spot, event);
      if (!edge) return;
      event.preventDefault();
      event.stopPropagation();
      commitDrop(carried, spot, edge);
    },
  };
}

/** Row padding plus the matching inset for the drop rule. */
function indentStyle(indent: number): CSSProperties {
  return {
    paddingLeft: 8 + indent,
    ["--drop-indent" as string]: `${8 + indent}px`,
  };
}

// ---- Rows ------------------------------------------------------------------

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

export function Sidebar({
  activeProjectId,
  collapsed,
  onToggleCollapsed,
  onNavigate,
}: SidebarProps) {
  const agents = useKeel((state) => state.agents);
  const accounts = useKeel((state) => state.accounts);
  const projects = useKeel((state) => state.projects);
  const status = useKeel((state) => state.status);
  const [sort, setSort] = useState<SortState>(IDLE);

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
        {/* Right padding leaves the toggle its own slot. */}
        <div className="flex h-[44px] shrink-0 items-center gap-2 pl-[14px] pr-[38px]">
          <h2 className="text-[12px] font-medium text-dim">Projects</h2>
          {projects.length ? (
            <span className="k-count">{projects.length}</span>
          ) : null}
          <span className="flex-1" />
          <button
            type="button"
            title="Add a folder"
            aria-label="Add a folder"
            onClick={() => void pickProjectFolder()}
            className="k-icon-btn size-6"
          >
            <Plus className="size-3.5" />
          </button>
        </div>

        <SortContext.Provider value={{ state: sort, setState: setSort }}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                className="min-h-0 flex-1 overflow-y-auto pb-2 pt-0.5"
                // A drop that lands between rows still has to end the drag.
                onDrop={() => setSort(IDLE)}
              >
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
        </SortContext.Provider>
      </div>

      <SidebarRail
        hidden={!collapsed}
        projects={projects}
        status={status}
        activeProjectId={activeProjectId}
        onNavigate={onNavigate}
      />
    </aside>
  );
}

// ---- Rail ------------------------------------------------------------------

/** Two initials for a multi-word name, else the first two letters: "Ke", "MA". */
function monogram(name: string): string {
  const [first = "", second = ""] = name.split(/[\s._-]+/).filter(Boolean);
  if (second) return (first.charAt(0) + second.charAt(0)).toUpperCase();
  return first.charAt(0).toUpperCase() + first.charAt(1).toLowerCase();
}

/** The loudest thing any agent in the project is doing. */
function projectAttention(
  project: Project,
  status: Record<string, PaneStatus>,
): Attention | null {
  let best: Attention | null = null;
  for (const deck of project.decks) {
    const attention = deckAttention(deck, status);
    if (attention === "working") return attention;
    best ??= attention;
  }
  return best;
}

const BADGE: Record<Attention, string> = {
  working: "var(--keel-working)",
  done: "var(--keel-done)",
};

function tileDelay(index: number): CSSProperties {
  return { ["--i" as string]: index };
}

/**
 * The folded sidebar. Every project is a tile you can click, right-click and
 * hover for its name; nothing else competes for 52 pixels.
 */
function SidebarRail({
  hidden,
  projects,
  status,
  activeProjectId,
  onNavigate,
}: {
  hidden: boolean;
  projects: Project[];
  status: Record<string, PaneStatus>;
  activeProjectId: string | null;
  onNavigate: () => void;
}) {
  return (
    <RailTipProvider>
      <nav aria-label="Projects" className="k-dock-rail" inert={hidden}>
        {/* The toggle's slot, level with the panel's header. */}
        <div className="h-[44px] shrink-0" />

        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden pb-2 pt-1 [scrollbar-width:none]">
          {projects.map((project, index) => (
            <RailTile
              key={project.id}
              project={project}
              index={index}
              selected={project.id === activeProjectId}
              attention={projectAttention(project, status)}
              onNavigate={onNavigate}
            />
          ))}

          {projects.length > 0 ? (
            <span
              aria-hidden
              className="mx-auto my-1 h-px w-4 shrink-0 bg-line-strong"
            />
          ) : null}

          <RailTip label="Add a folder">
            <button
              type="button"
              aria-label="Add a folder"
              onClick={() => void pickProjectFolder()}
              style={tileDelay(projects.length)}
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

function RailTile({
  project,
  index,
  selected,
  attention,
  onNavigate,
}: {
  project: Project;
  index: number;
  selected: boolean;
  attention: Attention | null;
  onNavigate: () => void;
}) {
  const total = project.decks.reduce(
    (sum, deck) => sum + listPanes(deck.tree).length,
    0,
  );

  return (
    <ContextMenu>
      <RailTip
        label={project.name}
        detail={total ? `${total} ${total === 1 ? "terminal" : "terminals"}` : undefined}
      >
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-label={project.name}
            aria-current={selected ? "page" : undefined}
            data-selected={selected}
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
 * by F2 or a double-click, draggable, and carrying its own context menu.
 */
function Row({
  group,
  menu,
  selected,
  onActivate,
  onRename,
  sortable,
  indent = 0,
  className,
  title,
  children,
}: {
  group: RowGroup;
  menu: () => MenuEntry[];
  selected: boolean;
  onActivate: () => void;
  onRename: () => void;
  sortable: SortableProps;
  indent?: number;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          {...sortable}
          role="button"
          tabIndex={0}
          data-selected={selected}
          title={title}
          style={indentStyle(indent)}
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
            } else if (matchesBinding(event, bindingFor("rename"))) {
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
  children: ReactNode;
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
  children: ReactNode;
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

/** A pane or deck tally. Tabular because it is a number you compare. */
function Count({ value, className }: { value: number; className?: string }) {
  if (!value) return null;
  return (
    <span
      className={cn(
        "shrink-0 pr-1 text-[11px] tabular-nums text-faint",
        className,
      )}
    >
      {value}
    </span>
  );
}

/**
 * Where terminals would be, in a project or deck that has none. It lines up
 * with a terminal row — a status-dot's width of air, then a mark-sized glyph —
 * so an empty project has the same silhouette as a full one. Terminals can be
 * dropped onto it.
 */
function EmptyRow({
  project,
  deck,
  indent,
  onAdd,
}: {
  project: Project;
  deck: Deck;
  indent: number;
  onAdd: () => void;
}) {
  const sortable = useSortable(
    { kind: "empty", projectId: project.id, deckId: deck.id },
    null,
  );

  return (
    <button
      type="button"
      {...sortable}
      onClick={onAdd}
      style={indentStyle(indent)}
      className="k-row group/empty text-[12px] text-faint hover:text-dim"
    >
      <span aria-hidden className="w-1.5 shrink-0" />
      <span className="grid size-4 shrink-0 place-items-center rounded-[5px] border border-dashed border-line-strong transition-colors group-hover/empty:border-foreground/30">
        <Plus className="size-2.5" />
      </span>
      Add terminals
    </button>
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
  const soloDeck = showDecks ? null : (project.decks[0] ?? null);
  const open = !project.collapsed;
  const leaf = selected ? leafOf(project, open, showDecks) : null;
  const renaming = useRenaming("project", project.id);
  const tree = { agents, accounts, status, onNavigate };
  const sortable = useSortable(
    { kind: "project", projectId: project.id, deckId: soloDeck?.id ?? null },
    renaming ? null : { kind: "project", projectId: project.id },
  );

  const addTerminals = () => {
    const state = useKeel.getState();
    state.selectProject(project.id);
    state.setLauncher(true);
    onNavigate();
  };

  return (
    <div className="pt-0.5">
      <Row
        group="project"
        menu={() => projectMenu(project.id)}
        selected={leaf?.kind === "project"}
        title={project.path}
        sortable={sortable}
        onActivate={() => {
          useKeel.getState().selectProject(project.id);
          onNavigate();
        }}
        onRename={() => startRename("project", project.id)}
      >
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          onClick={(event) => {
            event.stopPropagation();
            useKeel.getState().toggleCollapsed(project.id);
          }}
          className="-ml-1 grid size-4 shrink-0 place-items-center rounded-[3px] text-faint transition-colors hover:text-foreground"
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
              <RowButton label="Add terminals" onClick={addTerminals}>
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
        ) : soloDeck && total > 0 ? (
          <div className="k-tree-group" style={guideAt(GUIDE.project)}>
            <PaneRows
              project={project}
              deck={soloDeck}
              depth={1}
              leaf={leaf}
              {...tree}
            />
          </div>
        ) : soloDeck ? (
          <EmptyRow
            project={project}
            deck={soloDeck}
            indent={INDENT[1]}
            onAdd={addTerminals}
          />
        ) : null
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
  const sortable = useSortable(
    { kind: "deck", projectId: project.id, deckId: deck.id },
    renaming ? null : { kind: "deck", projectId: project.id, deckId: deck.id },
  );

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
        indent={INDENT[1]}
        sortable={sortable}
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
            "grid h-4 min-w-4 shrink-0 place-items-center rounded-full px-1 text-[10px] font-semibold tabular-nums transition-colors",
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
        <EmptyRow
          project={project}
          deck={deck}
          indent={INDENT[2]}
          onAdd={addHere}
        />
      ) : (
        <div className="k-tree-group" style={guideAt(GUIDE.deck)}>
          <PaneRows
            project={project}
            deck={deck}
            depth={2}
            leaf={active ? leaf : null}
            {...tree}
          />
        </div>
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
            deck={deck}
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
  deck,
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
  deck: Deck;
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
  const spot = {
    kind: "pane",
    projectId: project.id,
    deckId: deck.id,
    paneId: pane.id,
  } as const;
  const sortable = useSortable(spot, renaming ? null : spot);

  return (
    <Row
      group="pane"
      menu={() => paneMenu(project.id, pane.id, "sidebar")}
      selected={selected}
      title={pane.cwd ?? project.path}
      indent={INDENT[depth] ?? INDENT[2]}
      sortable={sortable}
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
      {pane.editor ? (
        <FileIcon name={pane.title} />
      ) : (
        <AgentMark
          agentId={agent?.id ?? pane.agentId ?? null}
          name={agent?.name}
          accent={agentAccent(agent?.accent)}
          size={16}
        />
      )}

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
              label={pane.editor ? "Close editor" : "Close terminal"}
              danger
              onClick={() =>
                useWorkspace.getState().closePaneSafely(project.id, pane.id)
              }
            >
              <X className="size-3" />
            </RowButton>
          </RowActions>
        </>
      )}
    </Row>
  );
}
