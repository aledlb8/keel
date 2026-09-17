/**
 * Dragging things around the dock.
 *
 * Scoping the sidebar to one workspace took a whole class of drag out of the
 * problem: you no longer drag a workspace among workspaces, because workspaces
 * are not rows any more. What is left is the three moves that are actually
 * about arranging work.
 *
 *  - **A project** reorders among the projects on screen. Its container comes
 *    from whatever it lands next to, so in "All projects" dropping under
 *    another group's heading joins that group, and inside one workspace the
 *    same gesture can only reorder — which is the only thing that means
 *    anything there. Moving a project to a group that is not on screen is the
 *    context menu's job, not a drag's.
 *  - **A deck** reorders among its project's decks.
 *  - **A terminal** goes anywhere inside its own project: between two others,
 *    onto a deck, or into an empty one.
 *
 * The rule for every drop is the same: an edge means "between", the middle of
 * something that can contain things means "inside".
 */

import {
  createContext,
  useContext,
  useState,
  type DragEvent,
  type HTMLAttributes,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";

import { listPanes } from "@/lib/tree";
import { groupDropTarget, projectDropTarget } from "@/lib/sidebarScope";
import { useKeel } from "@/state/store";

/** The thing being carried. */
export type DragItem =
  | { kind: "project"; projectId: string }
  | { kind: "deck"; projectId: string; deckId: string }
  | { kind: "pane"; projectId: string; deckId: string; paneId: string };

/**
 * A row that can receive a drop. A project row carries its only deck's id when
 * its terminals sit straight under it, so a terminal can land on it.
 */
export type DropSpot =
  | { kind: "group"; workspaceId: string }
  | { kind: "project"; projectId: string; deckId: string | null }
  | { kind: "deck"; projectId: string; deckId: string }
  | { kind: "pane"; projectId: string; deckId: string; paneId: string }
  | { kind: "empty"; projectId: string; deckId: string };

export type Edge = "before" | "after" | "inside";

interface SortState {
  item: DragItem | null;
  over: { key: string; edge: Edge } | null;
}

const IDLE: SortState = { item: null, over: null };

const SortContext = createContext<{
  state: SortState;
  setState: Dispatch<SetStateAction<SortState>>;
} | null>(null);

export function SortProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SortState>(IDLE);
  return (
    <SortContext.Provider value={{ state, setState }}>
      {/* A drop that lands between rows still has to end the drag. */}
      <div className="contents" onDrop={() => setState(IDLE)}>
        {children}
      </div>
    </SortContext.Provider>
  );
}

function spotKey(spot: DropSpot): string {
  switch (spot.kind) {
    case "group":
      return `group:${spot.workspaceId}`;
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
  const y = (event.clientY - rect.top) / Math.max(rect.height, 1);
  const half: Edge = y < 0.5 ? "before" : "after";

  if (item.kind === "project") {
    if (spot.kind === "group") return "inside";
    return spot.kind === "project" ? half : null;
  }

  // Decks and terminals never leave their project.
  if (spot.kind === "group") return null;
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

  if (item.kind === "project") {
    const dest =
      spot.kind === "group"
        ? groupDropTarget(state.workspaces, item.projectId, spot.workspaceId)
        : spot.kind === "project"
          ? projectDropTarget(
              state.workspaces,
              state.sidebar,
              item.projectId,
              spot.projectId,
              edge === "after",
            )
          : null;
    if (dest) state.placeProjectIn(item.projectId, dest);
    return;
  }

  const project = state.projects.find((entry) => entry.id === item.projectId);
  if (!project || spot.kind === "group") return;

  if (item.kind === "deck") {
    if (spot.kind !== "deck") return;
    const rest = project.decks.filter((entry) => entry.id !== item.deckId);
    const at = rest.findIndex((entry) => entry.id === spot.deckId);
    if (at >= 0) {
      state.reorderDeck(project.id, item.deckId, at + (edge === "after" ? 1 : 0));
    }
    return;
  }

  const deck = project.decks.find((entry) => entry.id === spot.deckId);
  if (!deck) return;
  const rest = listPanes(deck.tree).filter((id) => id !== item.paneId);
  let index = rest.length;
  if (spot.kind === "pane") {
    const at = rest.indexOf(spot.paneId);
    if (at >= 0) index = at + (edge === "after" ? 1 : 0);
  }
  state.placePane(project.id, item.paneId, deck.id, index);
}

export type SortableProps = HTMLAttributes<HTMLElement> & {
  "data-drop"?: Edge | undefined;
  "data-dragging"?: "true" | undefined;
};

/**
 * Wire a row into the dock's drag and drop. `item` is what dragging this row
 * picks up; pass null for rows that only receive drops, or while renaming.
 */
export function useSortable(
  spot: DropSpot,
  item: DragItem | null,
): SortableProps {
  const context = useContext(SortContext);
  if (!context) return {};
  const { state, setState } = context;
  const key = spotKey(spot);

  const dragging =
    item && state.item && sameThing(state.item, spot)
      ? ("true" as const)
      : undefined;
  const drop = state.over?.key === key ? state.over.edge : undefined;

  return {
    ...(item ? { draggable: true as const } : {}),
    ...(dragging ? { "data-dragging": dragging } : {}),
    ...(drop ? { "data-drop": drop } : {}),
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
