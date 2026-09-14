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
 * by the work on it, not just "Deck 2" and a pair of agent badges.
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
    <div className="absolute inset-0 z-50 flex flex-col bg-[color:var(--keel-chrome-strong)] backdrop-blur-[var(--keel-blur-strong)]">
      <div className="flex h-[38px] shrink-0 items-center gap-2.5 border-b border-line pl-4 pr-1.5">
        <span className="text-[13px] font-medium text-foreground">{project.name}</span>
        <span aria-hidden className="h-3 w-px bg-line-strong" />
        <span className="text-[13px] text-faint">
          Drag a terminal onto another deck to move it
        </span>
        <button
          type="button"
          aria-label="Close overview"
          onClick={onClose}
          className="k-icon-btn ml-auto size-[28px]"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3.5 overflow-y-auto p-5 pt-1">
        {project.decks.map((deck, index) => {
          const active = deck.id === project.activeDeckId;
          const count = listPanes(deck.tree).length;
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
                "flex flex-col overflow-hidden rounded-[var(--keel-r-window)] border bg-[color:var(--keel-term-bg)] shadow-[var(--keel-lift)] transition-colors",
                over === deck.id
                  ? "border-foreground/50"
                  : active
                    ? "border-line-strong"
                    : "border-line",
              )}
            >
              <div className="flex items-center gap-2 px-2.5 py-2">
                <span
                  className={cn(
                    "grid h-[19px] min-w-[19px] shrink-0 place-items-center rounded-[var(--keel-r-chip)] px-1 font-mono text-[11px] tabular-nums",
                    active ? "bg-veil-3 text-foreground" : "text-faint",
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
                    onClick={() => {
                      useKeel.getState().selectDeck(project.id, deck.id);
                      onClose();
                    }}
                    title="Double-click to rename"
                    className="min-w-0 flex-1 truncate text-left text-[13px] text-dim transition-colors hover:text-foreground"
                  >
                    {deck.name}
                  </button>
                )}

                <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
                  {count}
                </span>
                <button
                  type="button"
                  aria-label={`Close ${deck.name}`}
                  onClick={() =>
                    useKeel.getState().removeDeck(project.id, deck.id)
                  }
                  data-danger="true"
                  className="k-icon-btn size-[20px]"
                >
                  <X className="size-2.5" />
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  useKeel.getState().selectDeck(project.id, deck.id);
                  onClose();
                }}
                className="flex aspect-[16/10] w-full flex-col p-2 pt-0"
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
          className="flex aspect-[16/10] flex-col items-center justify-center gap-2 rounded-[var(--keel-r-window)] border border-dashed border-line-strong text-[13px] text-dim transition-colors hover:border-foreground/25 hover:bg-veil hover:text-foreground"
        >
          <Plus className="size-4" />
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
