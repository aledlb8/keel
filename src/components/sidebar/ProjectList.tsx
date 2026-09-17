/**
 * The body of the dock: the projects in the current scope, and what is inside
 * the ones you have open.
 *
 * Three levels, never four. A workspace is the scope now, not a row, so the
 * indent scale is project → deck → terminal and it stops there. Decks only
 * appear at all once a project has two of them; with one, its terminals sit
 * straight under the project and nothing here mentions decks.
 *
 * **Exactly one row is ever filled.** Selecting a terminal makes its deck and
 * project current too, and filling all three would stack into one tall blob. So
 * the fill goes to the deepest row that is actually current — the focused
 * terminal, else the active deck, else the project — and the rows above it say
 * "you are inside me" with brighter text instead. See `leafOf`.
 *
 * While the filter has something in it, projects open themselves and show only
 * the terminals that matched, flattened out of their decks: when you are
 * looking for a name, the arrangement it happens to sit in is noise.
 */

import { Plus, X } from "lucide-react";
import { ChevronRight } from "lucide-react";

import { AgentMark } from "@/components/AgentMark";
import { InlineRename } from "@/components/InlineRename";
import { StatusDot } from "@/components/StatusDot";
import { WorkspaceMark } from "@/components/WorkspaceMark";
import { FileIcon } from "@/components/inspector/FileIcon";
import {
  ContextMenuEntries,
} from "@/components/menu/MenuEntries";
import {
  deckMenu,
  paneMenu,
  pickProjectFolder,
  projectMenu,
  workspaceMenu,
} from "@/components/menu/actions";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { agentAccent } from "@/lib/tokens";
import { listPanes } from "@/lib/tree";
import { cn } from "@/lib/utils";
import type { FilteredProject } from "@/lib/sidebarScope";
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
} from "@/state/store";
import { useWorkspace } from "@/state/workspace";
import { useSortable } from "./dnd";
import {
  Count,
  HIDE_ON_HOVER,
  MoreButton,
  Row,
  RowActions,
  RowButton,
  startRename,
  stopRename,
  useRenaming,
} from "./rows";

/** Which row of the selected project carries the fill. */
type Leaf =
  | { kind: "project" }
  | { kind: "deck" }
  | { kind: "pane"; id: string };

/**
 * The deepest row that is actually current, and so the only one that gets a
 * fill. A closed project is its own leaf; an open one hands the fill down to
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

/** The loudest thing any agent in the project is doing. */
export function projectAttention(
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

function terminalsIn(project: Project): number {
  return project.decks.reduce((sum, deck) => sum + listPanes(deck.tree).length, 0);
}

interface ListProps {
  agents: Agent[];
  accounts: AgentAccount[];
  status: Record<string, PaneStatus>;
  activeProjectId: string | null;
  onNavigate: () => void;
}

export function ProjectList({
  entries,
  filtering,
  showGroups,
  ...rest
}: ListProps & {
  entries: FilteredProject[];
  filtering: boolean;
  /**
   * Whether to caption each run of projects with the group it belongs to. Only
   * "All projects" ever does: inside one workspace the heading would name the
   * thing the switcher above it already names.
   */
  showGroups: boolean;
}) {
  let lastGroup: string | null | undefined;

  return (
    <>
      {entries.map((entry) => {
        const heading =
          showGroups && entry.groupId !== lastGroup ? (
            <GroupHeading
              key={`head:${entry.groupId ?? "loose"}`}
              workspaceId={entry.groupId}
              name={entry.groupName}
            />
          ) : null;
        lastGroup = entry.groupId;

        return (
          <div key={entry.project.id} className="contents">
            {heading}
            <ProjectSection
              project={entry.project}
              panes={entry.panes}
              filtering={filtering}
              {...rest}
            />
          </div>
        );
      })}
    </>
  );
}

/**
 * Which group the projects under it belong to. Only ever drawn in the
 * "All projects" scope, where more than one group is on screen at once —
 * inside a single workspace it would name the thing the header already names.
 * A project dragged onto it joins that group.
 */
function GroupHeading({
  workspaceId,
  name,
}: {
  workspaceId: string | null;
  name: string | null;
}) {
  const sortable = useSortable(
    workspaceId
      ? { kind: "group", workspaceId }
      : { kind: "group", workspaceId: "" },
    null,
  );
  const renaming = useRenaming("workspace", workspaceId ?? "");

  if (!workspaceId || !name) {
    return <div className="k-group-head k-group-head-loose">Ungrouped</div>;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div {...sortable} className="k-group-head">
          <WorkspaceMark name={name} size={14} />
          {renaming ? (
            <InlineRename
              value={name}
              className="h-5 text-[11px]"
              onCommit={(next) =>
                useKeel.getState().renameWorkspace(workspaceId, next)
              }
              onDone={stopRename}
            />
          ) : (
            <span
              className="min-w-0 flex-1 truncate"
              onDoubleClick={() => startRename("workspace", workspaceId)}
            >
              {name}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuEntries entries={() => workspaceMenu(workspaceId)} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ProjectSection({
  project,
  panes,
  filtering,
  agents,
  accounts,
  status,
  activeProjectId,
  onNavigate,
}: ListProps & {
  project: Project;
  /** Filter hits, flattened out of their decks, or null for the whole tree. */
  panes: string[] | null;
  filtering: boolean;
}) {
  const selected = project.id === activeProjectId;
  const total = terminalsIn(project);
  const showDecks = project.decks.length > 1 && !filtering;
  const soloDeck = showDecks ? null : (project.decks[0] ?? null);
  // A filter opens what it found; otherwise the project remembers how you left it.
  const open = filtering ? true : !project.collapsed;
  const leaf = selected ? leafOf(project, open, showDecks) : null;
  const attention = projectAttention(project, status);
  const renaming = useRenaming("project", project.id);
  const tree = { agents, accounts, status, activeProjectId, onNavigate };
  const sortable = useSortable(
    { kind: "project", projectId: project.id, deckId: soloDeck?.id ?? null },
    renaming || filtering ? null : { kind: "project", projectId: project.id },
  );

  const addTerminals = () => {
    const state = useKeel.getState();
    state.selectProject(project.id);
    state.setLauncher(true);
    onNavigate();
  };

  return (
    <div className="k-project">
      <Row
        group="project"
        menu={() => projectMenu(project.id)}
        name={project.name}
        selected={leaf?.kind === "project"}
        inside={selected && leaf?.kind !== "project"}
        depth={0}
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
          disabled={filtering}
          onClick={(event) => {
            event.stopPropagation();
            useKeel.getState().toggleCollapsed(project.id);
          }}
          className="k-twisty"
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
            <span className="k-row-name">{project.name}</span>
            {/* Closed, the project speaks for what is inside it. Open, every
                terminal is already showing its own dot and a second one here
                would only be the same news twice. */}
            {!open && attention ? <StatusDot status={attention} /> : null}
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

      {!open ? null : panes ? (
        <div className="k-tree-group" style={{ ["--guide" as string]: "20px" }}>
          {panes.map((paneId) => {
            const deck = project.decks.find((entry) => paneId in entry.panes);
            const pane = deck?.panes[paneId];
            if (!deck || !pane) return null;
            return (
              <PaneRow
                key={paneId}
                project={project}
                deck={deck}
                pane={pane}
                depth={1}
                draggable={false}
                selected={leaf?.kind === "pane" && leaf.id === paneId}
                focused={deck.id === project.activeDeckId && deck.focused === paneId}
                {...tree}
              />
            );
          })}
        </div>
      ) : showDecks ? (
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
        <div className="k-tree-group" style={{ ["--guide" as string]: "20px" }}>
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
          depth={1}
          onAdd={addTerminals}
        />
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
}: ListProps & {
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
        name={deck.name}
        selected={active && leaf?.kind === "deck"}
        inside={active && leaf?.kind === "pane"}
        depth={1}
        className="k-row-sub"
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
        <span className="k-deck-no" data-active={active}>
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
            <span className="k-row-name">{deck.name}</span>
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
        <EmptyRow project={project} deck={deck} depth={2} onAdd={addHere} />
      ) : (
        <div className="k-tree-group" style={{ ["--guide" as string]: "34px" }}>
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
  ...tree
}: ListProps & {
  project: Project;
  deck: Deck;
  depth: 1 | 2;
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
            selected={leaf?.kind === "pane" && leaf.id === paneId}
            focused={active && deck.focused === paneId}
            {...tree}
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
  selected,
  focused,
  draggable = true,
  agents,
  accounts,
  status,
  onNavigate,
}: ListProps & {
  project: Project;
  deck: Deck;
  pane: Pane;
  depth: 1 | 2;
  selected: boolean;
  focused: boolean;
  draggable?: boolean;
}) {
  const agent = agents.find((entry) => entry.id === pane.agentId) ?? null;
  const account =
    accounts.find((entry) => entry.id === pane.accountId) ?? null;
  const renaming = useRenaming("pane", pane.id);
  const spot = {
    kind: "pane",
    projectId: project.id,
    deckId: deck.id,
    paneId: pane.id,
  } as const;
  const sortable = useSortable(spot, renaming || !draggable ? null : spot);

  return (
    <Row
      group="pane"
      menu={() => paneMenu(project.id, pane.id, "sidebar")}
      name={pane.title}
      selected={selected}
      depth={depth}
      title={pane.cwd ?? project.path}
      className="k-row-sub"
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
      <StatusDot status={status[pane.id] ?? "idle"} />
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
          <span className={cn("k-row-name", focused && "font-medium")}>
            {pane.title}
          </span>
          {account ? (
            <span
              className={cn(
                "max-w-[64px] shrink-0 truncate pr-0.5 text-[11px] text-faint",
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

/**
 * Where something would be, in a place that has none. It keeps the silhouette
 * of the row it stands in for, so an empty project has the same shape as a full
 * one. Things can be dropped onto it.
 */
function EmptyRow({
  project,
  deck,
  depth,
  onAdd,
}: {
  project: Project;
  deck: Deck;
  depth: 1 | 2;
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
      data-depth={depth}
      className="k-row k-row-sub group/empty text-faint hover:text-dim"
    >
      <span aria-hidden className="w-1.5 shrink-0" />
      <span className="k-add-glyph">
        <Plus className="size-2.5" />
      </span>
      Add terminals
    </button>
  );
}

/**
 * Nothing in this scope. An empty screen is an invitation to act, so it is one
 * target rather than a sentence with a button under it.
 */
export function EmptyScope({ workspaceId }: { workspaceId: string | null }) {
  return (
    <div className="px-[var(--keel-inset)] pt-1">
      <button
        type="button"
        onClick={() => void pickProjectFolder(workspaceId ?? undefined)}
        className="k-empty-target"
      >
        <span className="flex items-center gap-1.5 text-[13px] text-foreground">
          <Plus className="size-3.5 text-dim" />
          Add a folder
        </span>
        <span className="text-[12px] leading-snug text-faint">
          Terminals are grouped by the project they run in.
        </span>
      </button>
    </div>
  );
}
