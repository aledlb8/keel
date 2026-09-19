/**
 * The canvas: every deck's geometry, and every terminal in the app.
 *
 * Two layers, and the separation between them is the whole design:
 *
 *  - **Geometry.** One invisible nest of flex boxes per deck, all stacked on top
 *    of each other, only the active one visible. They draw nothing; they exist to
 *    be measured. Seams live here too.
 *  - **Terminals.** A single flat list, keyed by pane id, positioned absolutely
 *    from those measurements.
 *
 * Because that list is flat and spans *every* deck of *every* project, a pane can
 * be split, moved, zoomed, or carried to another deck entirely without React ever
 * reparenting it. Reparenting unmounts, and unmounting an xterm throws away the
 * scrollback and kills the agent inside it.
 *
 * Dragging a pane by its header works off the same measurements: where the
 * pointer is (see `dropTargetAt`) decides which pane or group it would land
 * against, an overlay shows that, and only letting go touches the tree.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Terminal } from "lucide-react";
import { toast } from "sonner";

import { AgentMark } from "@/components/AgentMark";
import { PaneView } from "@/components/PaneView";
import { dropTargetAt, type Box, type DropTarget } from "@/lib/dock";
import type { TitleSource } from "@/lib/paneTitle";
import { shortcutKeys } from "@/lib/keymap";
import { agentAccent } from "@/lib/tokens";
import { listPanes } from "@/lib/tree";
import { cn } from "@/lib/utils";
import type {
  Agent,
  Deck,
  Direction,
  LayoutNode,
  Pane,
  PaneActivity,
  Project,
} from "@/lib/types";
import { activeDeck, useKeel } from "@/state/store";
import { useWorkspace } from "@/state/workspace";

/**
 * Air between panes. Half of it comes off each side of every pane.
 *
 * Rounded windows need more room than square ones did: at a tight gap the
 * corners of two neighbours read as a defect rather than as a gap, and the
 * radius went up to 12. Matches `--keel-gutter`.
 */
const GAP = 12;

type Rect = Box;

/** How far the pointer travels before a press on a header becomes a drag. */
const DRAG_THRESHOLD = 5;

/**
 * How long after the layout changes shape that panes glide to their new places.
 * Only a change of shape opens this window — a split, a close, a drop, a zoom —
 * so dragging a seam or resizing the window still moves panes in the same frame.
 */
const MOTION_WINDOW_MS = 400;

/** A deck's arrangement without its sizes: which panes, in which splits. */
function shapeOf(node: LayoutNode | null): string {
  if (!node) return "";
  if (node.kind === "pane") return node.id;
  return `${node.direction}(${node.children.map(shapeOf).join(",")})`;
}

/** A pane in flight. Coordinates are relative to the canvas. */
interface PaneDrag {
  paneId: string;
  x: number;
  y: number;
  /** Where it would land if let go now. */
  target: DropTarget | null;
}

export interface CanvasProps {
  projects: Project[];
  activeProjectId: string | null;
  onAddTerminals: () => void;
}

export function Canvas({
  projects,
  activeProjectId,
  onAddTerminals,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rects, setRects] = useState<Record<string, Rect>>({});
  // The drag handlers outlive a render; they read the latest measurements here.
  const rectsRef = useRef(rects);
  useEffect(() => {
    rectsRef.current = rects;
  }, [rects]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<PaneDrag | null>(null);
  /** Bumping a pane's generation respawns its process in the same terminal. */
  const generations = useKeel((state) => state.generations);

  const agents = useKeel((state) => state.agents);
  const accounts = useKeel((state) => state.accounts);
  const exited = useKeel((state) => state.exited);

  const project = projects.find((item) => item.id === activeProjectId) ?? null;
  const deck = activeDeck(project);

  // Decided during render, not in an effect: a pane's own layout effect runs
  // before this component's, and it has to see the window already open.
  const motionUntil = useRef(0);
  const shape = `${shapeOf(deck?.tree ?? null)}|${deck?.zoomed ?? ""}`;
  const lastLayout = useRef({ deckId: deck?.id, shape });
  if (lastLayout.current.deckId !== deck?.id) {
    // Switching decks or projects moves nothing; it only changes what is shown.
    lastLayout.current = { deckId: deck?.id, shape };
  } else if (lastLayout.current.shape !== shape) {
    lastLayout.current.shape = shape;
    motionUntil.current = performance.now() + MOTION_WINDOW_MS;
  }

  /**
   * One sweep measures every deck of every project at once. Pane ids are unique
   * app-wide, so a single `querySelectorAll` over the container is enough — even
   * for the hidden decks, which keep their layout because they are hidden with
   * `visibility` rather than `display`.
   */
  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const base = container.getBoundingClientRect();
    if (base.width === 0 || base.height === 0) return;

    setSize((previous) =>
      previous.width === base.width && previous.height === base.height
        ? previous
        : { width: base.width, height: base.height },
    );

    const inset = GAP / 2;
    const next: Record<string, Rect> = {};
    for (const slot of container.querySelectorAll<HTMLElement>("[data-slot]")) {
      const id = slot.dataset.slot;
      if (!id) continue;
      const box = slot.getBoundingClientRect();
      next[id] = {
        left: Math.round(box.left - base.left + inset),
        top: Math.round(box.top - base.top + inset),
        width: Math.max(0, Math.round(box.width - GAP)),
        height: Math.max(0, Math.round(box.height - GAP)),
      };
    }

    setRects((previous) => {
      const ids = Object.keys(next);
      const unchanged =
        ids.length === Object.keys(previous).length &&
        ids.every((id) => {
          const before = previous[id];
          const after = next[id];
          return (
            before !== undefined &&
            after !== undefined &&
            before.left === after.left &&
            before.top === after.top &&
            before.width === after.width &&
            before.height === after.height
          );
        });
      return unchanged ? previous : next;
    });
  }, []);

  // `projects` changes identity on any layout edit, which is exactly when the
  // geometry needs re-reading.
  useLayoutEffect(() => {
    measure();
  }, [measure, projects, activeProjectId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // ResizeObserver runs before paint. Flushing the rects here means the
    // panes move in the same frame as the window, instead of one frame late
    // with a strip of ground showing around every terminal.
    const observer = new ResizeObserver(() => {
      flushSync(() => {
        measure();
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [measure]);

  const focusPane = useCallback(
    (paneId: string) =>
      project && useKeel.getState().focusPane(project.id, paneId),
    [project],
  );
  const noteOutput = useCallback(
    (paneId: string) => useKeel.getState().noteOutput(paneId),
    [],
  );
  const noteActivity = useCallback(
    (paneId: string, kind: PaneActivity, data?: string) =>
      useKeel.getState().noteActivity(paneId, kind, data),
    [],
  );
  const titlePane = useCallback(
    (paneId: string, title: string, source: TitleSource) =>
      useKeel.getState().autoTitlePane(paneId, title, source),
    [],
  );
  const cwdPane = useCallback(
    (paneId: string, dir: string) => useKeel.getState().notePaneCwd(paneId, dir),
    [],
  );
  const splitPane = useCallback(
    (paneId: string, direction: Direction) =>
      project && useKeel.getState().duplicatePane(project.id, paneId, direction),
    [project],
  );
  const zoomPane = useCallback(
    (paneId: string) =>
      project && useKeel.getState().toggleZoom(project.id, paneId),
    [project],
  );
  const closePane = useCallback(
    (paneId: string) =>
      project && useWorkspace.getState().closePaneSafely(project.id, paneId),
    [project],
  );
  // The respawn reports itself (noteActivity "spawn"), which clears "exited".
  const restartPane = useCallback(
    (paneId: string) => useKeel.getState().restartPane(paneId),
    [],
  );
  const changeAccount = useCallback(
    (paneId: string, accountId: string | null) => {
      if (!project) return;
      useKeel.getState().setPaneAccount(project.id, paneId, accountId);
      restartPane(paneId);
    },
    [project, restartPane],
  );
  const createAccount = useCallback(
    (paneId: string, agentId: string, name: string) => {
      if (!project) return;
      const accountId = useKeel.getState().addAccount(agentId, name);
      if (!accountId) return;
      useKeel.getState().setPaneAccount(project.id, paneId, accountId);
      restartPane(paneId);
    },
    [project, restartPane],
  );

  const onSpawnResult = useCallback(
    (paneId: string, ok: boolean, reason?: string) => {
      const keel = useKeel.getState();
      if (ok) {
        keel.settleRestore(paneId, true);
        keel.markSessionReady(paneId);
        return;
      }

      keel.noteSpawnFail(paneId);
      const body =
        reason && reason.trim()
          ? reason.trim()
          : "The agent process failed to start.";
      toast.error("Couldn't start agent", {
        description: body,
        action: {
          label: "Try again",
          onClick: () => restartPane(paneId),
        },
      });
    },
    [restartPane],
  );

  /**
   * A press on a pane's header. Nothing happens until the pointer has moved a
   * few pixels, so clicks and double-clicks on the header keep working; after
   * that the pane follows the pointer until it is let go (drop) or Escape is
   * pressed (cancel).
   */
  const startPaneDrag = useCallback(
    (paneId: string, event: React.PointerEvent) => {
      const container = containerRef.current;
      const state = useKeel.getState();
      const owner = state.projects.find(
        (item) => item.id === state.activeProjectId,
      );
      const current = activeDeck(owner);
      const tree = current?.tree;
      if (!container || !owner || !tree || current.zoomed) return;
      const onDeck = listPanes(tree);
      if (onDeck.length < 2 || !onDeck.includes(paneId)) return;

      // Only this deck's panes: hidden decks are measured too, underneath.
      const boxes: Record<string, Box> = {};
      for (const id of onDeck) {
        const box = rectsRef.current[id];
        if (box) boxes[id] = box;
      }

      const originX = event.clientX;
      const originY = event.clientY;
      let latest: PaneDrag | null = null;

      const onMove = (move: PointerEvent) => {
        if (
          !latest &&
          Math.hypot(move.clientX - originX, move.clientY - originY) <
            DRAG_THRESHOLD
        ) {
          return;
        }
        const base = container.getBoundingClientRect();
        const x = move.clientX - base.left;
        const y = move.clientY - base.top;
        latest = {
          paneId,
          x,
          y,
          target: dropTargetAt(tree, boxes, paneId, x, y),
        };
        setDrag(latest);
      };

      const finish = (commit: boolean) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        setDrag(null);
        const target = latest?.target;
        if (commit && target) {
          useKeel
            .getState()
            .dropPane(owner.id, paneId, target.nodeId, target.zone);
        }
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== "Escape" || !latest) return;
        key.preventDefault();
        key.stopPropagation();
        finish(false);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    },
    [],
  );

  const zoomRect: Rect = {
    left: GAP / 2,
    top: GAP / 2,
    width: Math.max(0, size.width - GAP),
    height: Math.max(0, size.height - GAP),
  };

  return (
    <div ref={containerRef} className="relative isolate h-full w-full">
      {/*
       * Geometry only — and deliberately *underneath* the panes.
       *
       * Every pane is inset by half a gap, so the strip between two panes is
       * covered by nothing. A seam sits exactly in that strip and stays
       * clickable without a layer over the panes, which would otherwise eat
       * clicks on the controls in a pane's top-right corner.
       */}
      {projects.map((item) =>
        item.decks.map((candidate) => (
          <div
            key={candidate.id}
            className="pointer-events-none absolute inset-0 z-0 flex"
            style={{
              visibility:
                item.id === activeProjectId && candidate.id === deck?.id
                  ? "visible"
                  : "hidden",
            }}
            aria-hidden={candidate.id !== deck?.id}
          >
            {candidate.tree ? (
              <Slots
                node={candidate.tree}
                projectId={item.id}
                deckId={candidate.id}
              />
            ) : null}
          </div>
        )),
      )}

      {projects.flatMap((item) =>
        item.decks.flatMap((candidate) =>
          listPanes(candidate.tree).map((paneId) => {
            const pane = candidate.panes[paneId];
            if (!pane) return null;
            const agent =
              agents.find((entry) => entry.id === pane.agentId) ?? null;
            const onScreen =
              item.id === activeProjectId && candidate.id === deck?.id;
            const isZoomed = candidate.zoomed === paneId;

            return (
              <PaneView
                key={paneId}
                projectId={item.id}
                pane={pane}
                agent={agent}
                accounts={accounts}
                exited={paneId in exited}
                focused={onScreen && candidate.focused === paneId}
                zoomed={isZoomed}
                cwd={pane.cwd ?? item.path}
                generation={generations[paneId] ?? 0}
                motion={motionUntil}
                rect={
                  onScreen && isZoomed ? zoomRect : (rects[paneId] ?? null)
                }
                hidden={
                  !onScreen ||
                  (candidate.zoomed !== null && !isZoomed)
                }
                onFocus={focusPane}
                onOutput={noteOutput}
                onActivity={noteActivity}
                onTitle={titlePane}
                onCwd={cwdPane}
                onSplit={splitPane}
                onZoom={zoomPane}
                onClose={closePane}
                onRestart={restartPane}
                onAccountChange={changeAccount}
                onCreateAccount={createAccount}
                onSpawnResult={onSpawnResult}
                onDragStart={startPaneDrag}
              />
            );
          }),
        ),
      )}

      {drag && deck ? (
        <DropOverlay
          drag={drag}
          rects={rects}
          pane={deck.panes[drag.paneId] ?? null}
          agents={agents}
        />
      ) : null}

      {project && !hasPanes(deck) ? (
        <div className="grid h-full place-items-center">
          <button
            type="button"
            onClick={onAddTerminals}
            className="flex w-[320px] flex-col items-center gap-2 rounded-[var(--keel-r-window)] border border-dashed border-line-strong px-6 py-7 text-center transition-colors hover:border-foreground/25 hover:bg-veil"
          >
            <Terminal className="size-5 text-faint" />
            <span className="text-title text-foreground">Add terminals</span>
            <span className="text-body leading-relaxed text-dim">
              Pick how many of each agent to run in {project.name}.
            </span>
            {shortcutKeys("addTerminals") ? (
              <span className="mt-1 rounded-[var(--keel-r-chip)] bg-veil-2 px-2 py-1 text-small font-medium text-faint">
                {shortcutKeys("addTerminals")}
              </span>
            ) : null}
          </button>
        </div>
      ) : null}

    </div>
  );
}

function hasPanes(deck: Deck | null): boolean {
  return deck ? listPanes(deck.tree).length > 0 : false;
}

/**
 * What a drag looks like: the pane being carried sinks back into the ground,
 * the space it would take lights up (the whole target, for a swap), and a chip
 * with its name rides along with the pointer.
 */
function DropOverlay({
  drag,
  rects,
  pane,
  agents,
}: {
  drag: PaneDrag;
  rects: Record<string, Rect>;
  pane: Pane | null;
  agents: Agent[];
}) {
  const source = rects[drag.paneId];
  const landing = drag.target?.box ?? null;
  const agent = agents.find((entry) => entry.id === pane?.agentId) ?? null;

  return (
    // Above every pane, so the terminals under the pointer don't take hover.
    <div className="absolute inset-0 z-40 cursor-grabbing">
      {source ? (
        <div
          className="k-fade-in absolute rounded-[var(--keel-r-window)] bg-[color:var(--keel-void)]/65"
          style={source}
        />
      ) : null}

      {landing ? (
        <div
          className="k-fade-in absolute grid place-items-center rounded-[var(--keel-r-window)] border border-foreground/35 bg-foreground/[0.07] transition-[left,top,width,height] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]"
          style={landing}
        >
          {drag.target?.zone === "center" ? (
            <span className="rounded-[var(--keel-r-chip)] bg-popover px-2 py-1 text-body text-dim shadow-[var(--keel-lift)]">
              Swap places
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        className="k-chip-in pointer-events-none absolute left-0 top-0 flex h-7 items-center gap-1.5 rounded-[var(--keel-r-control)] border border-line-strong bg-popover pl-1.5 pr-2.5 text-body shadow-[var(--keel-lift-strong)]"
        style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 14}px)` }}
      >
        <AgentMark
          agentId={pane?.agentId ?? null}
          name={agent?.name}
          accent={agentAccent(agent?.accent)}
          size={16}
        />
        <span className="max-w-48 truncate">{pane?.title ?? "Terminal"}</span>
      </div>
    </div>
  );
}

function Slots({
  node,
  projectId,
  deckId,
}: {
  node: LayoutNode;
  projectId: string;
  deckId: string;
}) {
  if (node.kind === "pane") {
    return <div data-slot={node.id} className="min-h-0 min-w-0 flex-1" />;
  }
  return <SplitSlots node={node} projectId={projectId} deckId={deckId} />;
}

function SplitSlots({
  node,
  projectId,
  deckId,
}: {
  node: Extract<LayoutNode, { kind: "split" }>;
  projectId: string;
  deckId: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const row = node.direction === "row";

  const startDrag = (seam: number) => (event: React.PointerEvent) => {
    event.preventDefault();
    const container = ref.current;
    if (!container) return;
    const total = row ? container.clientWidth : container.clientHeight;
    if (total <= 0) return;

    const target = event.currentTarget as HTMLElement;
    let last = row ? event.clientX : event.clientY;
    target.setPointerCapture(event.pointerId);

    const onMove = (move: PointerEvent) => {
      const position = row ? move.clientX : move.clientY;
      const delta = (position - last) / total;
      if (delta === 0) return;
      last = position;
      useKeel.getState().resizeSplit(projectId, deckId, node.id, seam, delta);
    };
    const onUp = () => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  const boundaries = node.sizes
    .slice(0, -1)
    .map((_, index) =>
      node.sizes.slice(0, index + 1).reduce((sum, size) => sum + size, 0),
    );

  return (
    <div
      ref={ref}
      className="relative flex h-full w-full"
      style={{ flexDirection: row ? "row" : "column" }}
    >
      {node.children.map((child, index) => (
        <div
          key={child.id}
          className="flex min-h-0 min-w-0"
          style={{
            flexGrow: node.sizes[index] ?? 1,
            flexBasis: 0,
            flexDirection: row ? "row" : "column",
          }}
        >
          <Slots node={child} projectId={projectId} deckId={deckId} />
        </div>
      ))}

      {boundaries.map((offset, index) => (
        <div
          key={`seam-${node.children[index]?.id ?? index}`}
          onPointerDown={startDrag(index)}
          // The seam draws nothing until you reach for it, and then only a
          // hairline down the middle of the gap — filling the whole gutter put a
          // bar between two windows that are meant to look like they are simply
          // sitting next to each other.
          className={cn(
            "group/seam pointer-events-auto absolute grid",
            row ? "place-items-center" : "content-center justify-items-stretch",
          )}
          style={
            row
              ? {
                  left: `calc(${offset * 100}% - ${GAP / 2}px)`,
                  top: 0,
                  width: GAP,
                  height: "100%",
                  cursor: "col-resize",
                }
              : {
                  top: `calc(${offset * 100}% - ${GAP / 2}px)`,
                  left: 0,
                  height: GAP,
                  width: "100%",
                  cursor: "row-resize",
                }
          }
        >
          <span
            aria-hidden
            className={cn(
              "rounded-full bg-line-strong opacity-0 transition-opacity duration-100 group-hover/seam:opacity-100",
              row ? "h-8 w-0.5" : "h-0.5 w-8",
            )}
          />
        </div>
      ))}
    </div>
  );
}

