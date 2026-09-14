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
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Terminal } from "lucide-react";
import { toast } from "sonner";

import { PaneView } from "@/components/PaneView";
import { listPanes } from "@/lib/tree";
import { cn } from "@/lib/utils";
import type { Deck, Direction, LayoutNode, Project } from "@/lib/types";
import { activeDeck, useKeel } from "@/state/store";

/**
 * Air between panes. Half of it comes off each side of every pane.
 *
 * Rounded windows need more room than square ones did: at a tight gap the
 * corners of two neighbours read as a defect rather than as a gap, and the
 * radius went up to 12. Matches `--keel-gutter`.
 */
const GAP = 12;

type Rect = { left: number; top: number; width: number; height: number };

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
  const [size, setSize] = useState({ width: 0, height: 0 });
  /** Bumping a pane's generation respawns its process in the same terminal. */
  const [generations, setGenerations] = useState<Record<string, number>>({});

  const agents = useKeel((state) => state.agents);
  const accounts = useKeel((state) => state.accounts);
  const status = useKeel((state) => state.status);

  const project = projects.find((item) => item.id === activeProjectId) ?? null;
  const deck = activeDeck(project);

  /**
   * One sweep measures every deck of every project at once. Pane ids are unique
   * app-wide, so a single `querySelectorAll` over the container is enough â€” even
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
            before &&
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
    const observer = new ResizeObserver(() => measure());
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
      project && useKeel.getState().closePane(project.id, paneId),
    [project],
  );
  const restartPane = useCallback((paneId: string) => {
    setGenerations((previous) => ({
      ...previous,
      [paneId]: (previous[paneId] ?? 0) + 1,
    }));
    // Clear exited so attention tracking can leave "dead" after a relaunch.
    useKeel.setState((state) => {
      if (state.status[paneId] !== "exited") return state;
      const status = { ...state.status };
      delete status[paneId];
      return { status };
    });
  }, []);
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

  const zoomRect: Rect = {
    left: GAP / 2,
    top: GAP / 2,
    width: Math.max(0, size.width - GAP),
    height: Math.max(0, size.height - GAP),
  };

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {/*
       * Geometry only â€” and deliberately *underneath* the panes.
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
                pane={pane}
                agent={agent}
                accounts={accounts}
                status={status[paneId] ?? "idle"}
                focused={onScreen && candidate.focused === paneId}
                zoomed={isZoomed}
                cwd={pane.cwd ?? item.path}
                generation={generations[paneId] ?? 0}
                rect={
                  onScreen && isZoomed ? zoomRect : (rects[paneId] ?? null)
                }
                hidden={
                  !onScreen ||
                  (candidate.zoomed !== null && !isZoomed)
                }
                onFocus={focusPane}
                onOutput={noteOutput}
                onSplit={splitPane}
                onZoom={zoomPane}
                onClose={closePane}
                onRestart={restartPane}
                onAccountChange={changeAccount}
                onCreateAccount={createAccount}
                onSpawnResult={onSpawnResult}
              />
            );
          }),
        ),
      )}

      {project && !hasPanes(deck) ? (
        <div className="grid h-full place-items-center">
          <button
            type="button"
            onClick={onAddTerminals}
            className="flex w-[320px] flex-col items-center gap-2 rounded-[var(--keel-r-window)] border border-dashed border-line-strong px-6 py-7 text-center transition-colors hover:border-foreground/25 hover:bg-veil"
          >
            <Terminal className="size-5 text-faint" />
            <span className="text-[15px] text-foreground">Add terminals</span>
            <span className="text-[12px] leading-relaxed text-dim">
              Pick how many of each agent to run in {project.name}.
            </span>
            <span className="mt-1 rounded-[var(--keel-r-chip)] bg-veil-2 px-2 py-1 font-mono text-[11px] text-faint">
              Alt+Shift+T
            </span>
          </button>
        </div>
      ) : null}

    </div>
  );
}

function hasPanes(deck: Deck | null): boolean {
  return deck ? listPanes(deck.tree).length > 0 : false;
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
          key={`seam-${node.children[index].id}`}
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

