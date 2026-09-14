/**
 * Every deck in the project, at once.
 *
 * The canvas can only ever show one arrangement. This is the other view: all of
 * them side by side, drawn to scale from the real layout trees.
 *
 * You can pick a running terminal up out of one deck and drop it on another. The
 * process is never touched — only which rectangle it is drawn in changes, because
 * the terminals live in a flat layer that spans every deck. That is what the whole
 * two-layer canvas is for.
 *
 * Each cell shows the same brief as the sidebar row, so a deck is identifiable
 * by the work on it, not just "Deck 2" and a pair of agent marks.
 */

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import { LayoutSchematic } from "@/components/LayoutSchematic";
import { listPanes } from "@/lib/tree";
import { cn } from "@/lib/utils";
import type { Agent, Project } from "@/lib/types";
import { useKeel } from "@/state/store";

export interface OverviewProps {
  project: Project;
  agents: Agent[];
  onClose: () => void;
}

export function Overview({ project, agents, onClose }: OverviewProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !renaming) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, renaming]);

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-[color:var(--keel-void)] animate-in fade-in-0 duration-150">
      <div className="flex h-[52px] shrink-0 items-center gap-3 pl-6 pr-3">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            {project.name}
          </span>
          <span className="shrink-0 text-[12px] text-faint">
            {project.decks.length} {project.decks.length === 1 ? "deck" : "decks"}
          </span>
        </div>
        <span className="ml-auto hidden truncate text-[12px] text-faint md:block">
          Drag a terminal onto another deck to move it
        </span>
        <button
          type="button"
          aria-label="Close overview"
          onClick={onClose}
          className="k-icon-btn size-[30px] rounded-[var(--keel-r-control)]"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 overflow-y-auto px-6 pb-6 pt-1">
        {project.decks.map((deck, index) => {
          const active = deck.id === project.activeDeckId;
          const count = listPanes(deck.tree).length;
          const open = () => {
            useKeel.getState().selectDeck(project.id, deck.id);
            onClose();
          };
          return (
            <div
              key={deck.id}
              onDragOver={(event) => {
                if (!dragging) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setOver(deck.id);
              }}
              onDragLeave={() => setOver((id) => (id === deck.id ? null : id))}
              onDrop={(event) => {
                event.preventDefault();
                const paneId =
                  event.dataTransfer.getData("text/keel-pane") || dragging;
                setOver(null);
                setDragging(null);
                if (paneId) {
                  useKeel
                    .getState()
                    .movePaneToDeck(project.id, paneId, deck.id);
                }
              }}
              className={cn(
                "group/deck flex flex-col overflow-hidden rounded-[14px] border bg-[color:var(--keel-chrome)] shadow-[var(--keel-lift)] transition-[border-color,box-shadow,transform] duration-150",
                over === deck.id
                  ? "border-foreground/40 shadow-[var(--keel-lift-strong)]"
                  : active
                    ? "border-line-strong"
                    : "border-line hover:border-line-strong",
              )}
            >
              <div className="flex h-11 items-center gap-2.5 pl-3 pr-2">
                <span
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums",
                    active
                      ? "bg-foreground text-background"
                      : "bg-veil-2 text-dim",
                  )}
                >
                  {index + 1}
                </span>

                {renaming === deck.id ? (
                  <DeckNameInput
                    initial={deck.name}
                    onCommit={(name) => {
                      useKeel.getState().renameDeck(project.id, deck.id, name);
                      setRenaming(null);
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <button
                    type="button"
                    onDoubleClick={() => setRenaming(deck.id)}
                    onClick={open}
                    title="Double-click to rename"
                    className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-foreground"
                  >
                    {deck.name}
                  </button>
                )}

                <span className="shrink-0 text-[12px] tabular-nums text-faint">
                  {count} {count === 1 ? "terminal" : "terminals"}
                </span>
                <button
                  type="button"
                  aria-label={`Close ${deck.name}`}
                  onClick={() =>
                    useKeel.getState().removeDeck(project.id, deck.id)
                  }
                  data-danger="true"
                  className="k-icon-btn size-6 opacity-0 transition-opacity group-hover/deck:opacity-100 focus-visible:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              </div>

              <button
                type="button"
                onClick={open}
                className="mx-2 mb-2 flex aspect-[16/10] flex-col rounded-[10px] bg-[color:var(--keel-void)] p-1.5"
              >
                <LayoutSchematic
                  deck={deck}
                  agents={agents}
                  draggingPaneId={dragging}
                  onPaneDragStart={setDragging}
                  onPaneDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                />
              </button>
            </div>
          );
        })}

        <button
          type="button"
          onClick={() => {
            useKeel.getState().addDeck(project.id);
            onClose();
          }}
          className="flex min-h-[200px] flex-col items-center justify-center gap-2.5 rounded-[14px] border border-dashed border-line-strong text-[13px] font-medium text-dim transition-colors hover:border-foreground/25 hover:bg-veil hover:text-foreground"
        >
          <span className="grid size-8 place-items-center rounded-full bg-veil-2">
            <Plus className="size-4" />
          </span>
          New deck
        </button>
      </div>
    </div>
  );
}

function DeckNameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      autoFocus
      defaultValue={initial}
      onBlur={(event) => onCommit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit(event.currentTarget.value);
        if (event.key === "Escape") onCancel();
      }}
      className="min-w-0 flex-1 rounded-[var(--keel-r-chip)] border border-line-strong bg-veil-2 px-2 py-1 text-[13px] outline-none transition-colors focus:border-foreground/40"
    />
  );
}
