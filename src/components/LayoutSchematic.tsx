/**
 * A deck, drawn small.
 *
 * It renders the real layout tree with the real proportions, so a schematic is
 * never a guess about what you would see — it is the same geometry at another
 * scale. Cells carry the agent's colour and short code, which reads better at
 * this size than actual terminal pixels ever would.
 */

import { agentAccent } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import type { Agent, Deck, LayoutNode } from "@/lib/types";

export interface LayoutSchematicProps {
  deck: Deck;
  agents: Agent[];
  /** Pane being dragged out of this deck, dimmed while it is in flight. */
  draggingPaneId?: string | null;
  /** Enables dragging a terminal out of the schematic and onto another deck. */
  onPaneDragStart?: (paneId: string) => void;
  onPaneDragEnd?: () => void;
}

export function LayoutSchematic({
  deck,
  agents,
  draggingPaneId,
  onPaneDragStart,
  onPaneDragEnd,
}: LayoutSchematicProps) {
  if (!deck.tree) {
    return (
      <div className="grid h-full place-items-center rounded-[var(--keel-r-chip)] border border-dashed border-line-strong text-[11px] text-faint">
        empty
      </div>
    );
  }

  return (
    <Node
      node={deck.tree}
      deck={deck}
      agents={agents}
      draggingPaneId={draggingPaneId}
      onPaneDragStart={onPaneDragStart}
      onPaneDragEnd={onPaneDragEnd}
    />
  );
}

function Node({
  node,
  deck,
  agents,
  draggingPaneId,
  onPaneDragStart,
  onPaneDragEnd,
}: { node: LayoutNode } & LayoutSchematicProps) {
  if (node.kind === "pane") {
    const pane = deck.panes[node.id];
    const agent = agents.find((entry) => entry.id === pane?.agentId) ?? null;
    const accent = agentAccent(agent?.accent);
    const draggable = Boolean(onPaneDragStart);

    return (
      <div
        draggable={draggable}
        onDragStart={(event) => {
          if (!draggable) return;
          event.stopPropagation();
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/keel-pane", node.id);
          onPaneDragStart?.(node.id);
        }}
        onDragEnd={onPaneDragEnd}
        title={pane?.title}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-[5px] border-l-2",
          draggable && "cursor-grab active:cursor-grabbing",
          draggingPaneId === node.id && "opacity-30",
        )}
        style={{
          borderLeftColor: accent,
          background: "var(--keel-term-solid)",
        }}
      >
        <span
          className="truncate font-mono text-[10px] font-semibold"
          style={{ color: accent }}
        >
          {agent?.short ?? "SH"}
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 gap-[4px]"
      style={{ flexDirection: node.direction === "row" ? "row" : "column" }}
    >
      {node.children.map((child, index) => (
        <div
          key={child.id}
          className="flex min-h-0 min-w-0"
          style={{
            flexGrow: node.sizes[index] ?? 1,
            flexBasis: 0,
            flexDirection: node.direction === "row" ? "row" : "column",
          }}
        >
          <Node
            node={child}
            deck={deck}
            agents={agents}
            draggingPaneId={draggingPaneId}
            onPaneDragStart={onPaneDragStart}
            onPaneDragEnd={onPaneDragEnd}
          />
        </div>
      ))}
    </div>
  );
}
