/**
 * Projects, their decks, and the terminals inside.
 *
 * Rows are inset from the panel and rounded, so a selected row reads as a chip
 * sitting in the list rather than as a band painted edge to edge. Indentation is
 * padding inside the row, which keeps every hover and every selection the same
 * width no matter how deep it sits.
 *
 * **Exactly one row is ever filled.** Selecting a terminal makes its deck and
 * its project current too, and painting all three the same grey stacked them
 * into a single tall blob that read as one chip overlapping its neighbours. So
 * the fill goes to the deepest thing that is actually current — the focused
 * terminal if there is one, else the active deck, else the project — and the
 * rows above it say "you are inside me" in weight and text colour instead. See
 * `leafOf`.
 *
 * The deck level collapses out of the tree whenever a project has only one — the
 * terminals hang straight off the folder, and nothing on screen mentions decks
 * until you actually open a second one.
 *
 * Selection is one-way on purpose: clicking the selected project does not
 * deselect it. There is no "no project" state to fall into.
 */

import { open as openFolder } from "@tauri-apps/plugin-dialog";
import { ChevronRight, FolderPlus, Plus, X } from "lucide-react";

import { StatusDot } from "@/components/StatusDot";
import { agentAccent } from "@/lib/tokens";
import { listPanes } from "@/lib/tree";
import { cn } from "@/lib/utils";
import type { Agent, Deck, PaneStatus, Project } from "@/lib/types";
import { activeDeck, deckAttention, useKeel } from "@/state/store";

/**
 * Left padding per level, added to the row's own 8px.
 *
 * The steps are wide enough to read as a hierarchy at a glance and tight enough
 * that a three-level tree still leaves room for a terminal's title.
 */
const INDENT = [0, 13, 24];

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
  onAddTerminals: (projectId: string) => void;
  /**
   * Fired whenever a row moves you somewhere. The canvas can be covered by the
   * overview, and navigating from over here has to get you out from under it —
   * otherwise the row lights up, the deck really does change, and the click
   * still looks like it did nothing.
   */
  onNavigate: () => void;
}

async function pickFolder() {
  const picked = await openFolder({
    directory: true,
    multiple: false,
    title: "Add a project folder",
  });
  if (typeof picked === "string") useKeel.getState().addProject(picked);
}

export function Sidebar({
  activeProjectId,
  onAddTerminals,
  onNavigate,
}: SidebarProps) {
  const agents = useKeel((state) => state.agents);
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
          onClick={() => void pickFolder()}
          className="k-icon-btn size-[24px]"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2 pt-0.5">
        {projects.length === 0 ? (
          <EmptyProjects />
        ) : (
          projects.map((project) => (
            <ProjectNode
              key={project.id}
              project={project}
              agents={agents}
              status={status}
              selected={project.id === activeProjectId}
              onAddTerminals={onAddTerminals}
              onNavigate={onNavigate}
            />
          ))
        )}
      </div>
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
        onClick={() => void pickFolder()}
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

function ProjectNode({
  project,
  agents,
  status,
  selected,
  onAddTerminals,
  onNavigate,
}: {
  project: Project;
  agents: Agent[];
  status: Record<string, PaneStatus>;
  selected: boolean;
  onAddTerminals: (projectId: string) => void;
  onNavigate: () => void;
}) {
  const total = project.decks.reduce(
    (sum, deck) => sum + listPanes(deck.tree).length,
    0,
  );
  const open = !project.collapsed && total > 0;
  // One deck is the common case: skip the level entirely rather than making
  // every project look like it has a hierarchy it does not use.
  const showDecks = project.decks.length > 1;
  const leaf = selected ? leafOf(project, open, showDecks) : null;

  return (
    <div className="pt-0.5">
      <div
        className="k-row group"
        data-selected={leaf?.kind === "project"}
        title={project.path}
        onClick={() => {
          useKeel.getState().selectProject(project.id);
          onNavigate();
        }}
      >
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          disabled={total === 0}
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

        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            selected ? "font-medium text-foreground" : "text-dim",
          )}
        >
          {project.name}
        </span>

        <Count value={total} className="group-hover:hidden" />

        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <button
            type="button"
            title="Add terminals"
            aria-label="Add terminals"
            onClick={(event) => {
              event.stopPropagation();
              onAddTerminals(project.id);
            }}
            className="k-icon-btn size-[21px]"
          >
            <Plus className="size-3" />
          </button>
          <button
            type="button"
            title="Remove project"
            aria-label="Remove project"
            data-danger="true"
            onClick={(event) => {
              event.stopPropagation();
              useKeel.getState().removeProject(project.id);
            }}
            className="k-icon-btn size-[21px]"
          >
            <X className="size-3" />
          </button>
        </span>
      </div>

      {open
        ? project.decks.map((deck, index) =>
            showDecks ? (
              <DeckNode
                key={deck.id}
                project={project}
                deck={deck}
                index={index}
                agents={agents}
                status={status}
                leaf={leaf}
                onNavigate={onNavigate}
              />
            ) : (
              <PaneRows
                key={deck.id}
                project={project}
                deck={deck}
                depth={1}
                agents={agents}
                status={status}
                leaf={leaf}
                onNavigate={onNavigate}
              />
            ),
          )
        : null}
    </div>
  );
}

/** A pane or deck tally. Mono and tabular because it is a number you compare. */
function Count({ value, className }: { value: number; className?: string }) {
  if (!value) return null;
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-[11px] tabular-nums text-faint",
        className,
      )}
    >
      {value}
    </span>
  );
}

function DeckNode({
  project,
  deck,
  index,
  agents,
  status,
  leaf,
  onNavigate,
}: {
  project: Project;
  deck: Deck;
  index: number;
  agents: Agent[];
  status: Record<string, PaneStatus>;
  leaf: Leaf | null;
  onNavigate: () => void;
}) {
  const active = deck.id === project.activeDeckId;
  const count = listPanes(deck.tree).length;
  const attention = deckAttention(deck, status);

  return (
    <>
      <div
        className="k-row group/deck"
        data-selected={active && leaf?.kind === "deck"}
        style={{ paddingLeft: 8 + INDENT[1] }}
        onClick={() => {
          useKeel.getState().selectDeck(project.id, deck.id);
          onNavigate();
        }}
      >
        {/* Decks are numbered everywhere else in the app; number them here too. */}
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
          {index + 1}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            active ? "font-medium text-foreground" : "text-dim",
          )}
        >
          {deck.name}
        </span>

        {!active && attention ? (
          <StatusDot status={attention} title={attention} />
        ) : null}

        <Count value={count} className="group-hover/deck:hidden" />
        <button
          type="button"
          aria-label={`Close ${deck.name}`}
          title={`Close ${deck.name}`}
          data-danger="true"
          onClick={(event) => {
            event.stopPropagation();
            useKeel.getState().removeDeck(project.id, deck.id);
          }}
          className="k-icon-btn hidden size-[21px] group-hover/deck:grid"
        >
          <X className="size-2.5" />
        </button>
      </div>

      <PaneRows
        project={project}
        deck={deck}
        depth={2}
        agents={agents}
        status={status}
        leaf={active ? leaf : null}
        onNavigate={onNavigate}
      />
    </>
  );
}

function PaneRows({
  project,
  deck,
  depth,
  agents,
  status,
  leaf,
  onNavigate,
}: {
  project: Project;
  deck: Deck;
  depth: number;
  agents: Agent[];
  status: Record<string, PaneStatus>;
  leaf: Leaf | null;
  onNavigate: () => void;
}) {
  const active = deck.id === project.activeDeckId;

  return (
    <>
      {listPanes(deck.tree).map((paneId) => {
        const pane = deck.panes[paneId];
        if (!pane) return null;
        const agent =
          agents.find((candidate) => candidate.id === pane.agentId) ?? null;
        const accent = agentAccent(agent?.accent);
        const state = status[paneId] ?? "idle";
        const focused = active && deck.focused === paneId;

        return (
          <div
            key={paneId}
            className="k-row group/pane"
            data-selected={leaf?.kind === "pane" && leaf.id === paneId}
            style={{ paddingLeft: 8 + (INDENT[depth] ?? INDENT[2]) }}
            title={pane.cwd ?? project.path}
            onClick={() => {
              // Reaching a terminal brings its project and deck with it.
              useKeel.getState().selectProject(project.id);
              useKeel.getState().focusPane(project.id, paneId);
              onNavigate();
            }}
          >
            <StatusDot status={state} fallback={accent} title={state} />
            <span
              className="shrink-0 font-mono text-[11px] font-medium"
              style={{ color: accent }}
            >
              {agent?.short ?? "SH"}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                focused ? "font-medium text-foreground" : "text-dim",
              )}
            >
              {pane.title}
            </span>
            <button
              type="button"
              aria-label={`Close ${pane.title}`}
              data-danger="true"
              onClick={(event) => {
                event.stopPropagation();
                useKeel.getState().closePane(project.id, paneId);
              }}
              className="k-icon-btn hidden size-[21px] group-hover/pane:grid"
            >
              <X className="size-2.5" />
            </button>
          </div>
        );
      })}
    </>
  );
}
