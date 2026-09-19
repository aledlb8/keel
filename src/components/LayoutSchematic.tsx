/**
 * A deck, drawn small.
 *
 * It renders the real layout tree with the real proportions, so a schematic is
 * never a guess about what you would see — it is the same geometry at another
 * scale. Each cell is a miniature pane card: the agent's mark and name, what it
 * is doing, and the brief the sidebar shows, so a deck of "Claude" and "Codex"
 * is still readable as the work those terminals are doing.
 */

import { AgentMark } from "@/components/AgentMark";
import { StatusDot } from "@/components/StatusDot";
import { isGenericLabel } from "@/lib/paneTitle";
import { agentAccent } from "@/lib/tokens";
import type { Agent, Deck, LayoutNode, PaneStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useKeel } from "@/state/store";

export interface LayoutSchematicProps {
  deck: Deck;
  agents: Agent[];
  /** Pane being dragged out of this deck, dimmed while it is in flight. */
  draggingPaneId?: string | null | undefined;
  /** Enables dragging a terminal out of the schematic and onto another deck. */
  onPaneDragStart?: ((paneId: string) => void) | undefined;
  onPaneDragEnd?: (() => void) | undefined;
}

export function LayoutSchematic(props: LayoutSchematicProps) {
  const status = useKeel((state) => state.status);

  if (!props.deck.tree) {
    return (
      <div className="grid h-full place-items-center rounded-[8px] border border-dashed border-line-strong text-body text-faint">
        Empty deck
      </div>
    );
  }

  return <Node node={props.deck.tree} status={status} {...props} />;
}

function Node({
  node,
  status,
  deck,
  agents,
  draggingPaneId,
  onPaneDragStart,
  onPaneDragEnd,
}: {
  node: LayoutNode;
  status: Record<string, PaneStatus>;
} & LayoutSchematicProps) {
  if (node.kind === "pane") {
    const pane = deck.panes[node.id];
    const agent = agents.find((entry) => entry.id === pane?.agentId) ?? null;
    const accent = agentAccent(agent?.accent);
    const draggable = Boolean(onPaneDragStart);
    const title = pane?.title ?? "";
    const brief = title && !isGenericLabel(title, agent) ? title : "";
    const state = status[node.id] ?? "idle";

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
        title={title}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 overflow-hidden rounded-[8px] border border-line p-2 text-left",
          "transition-[border-color,opacity] duration-150 hover:border-line-strong",
          draggable && "cursor-grab active:cursor-grabbing",
          draggingPaneId === node.id && "opacity-30",
        )}
        style={{
          background: `linear-gradient(180deg, color-mix(in srgb, ${accent} 10%, var(--keel-term-solid)) 0%, var(--keel-term-solid) 72%)`,
        }}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <AgentMark
            agentId={agent ? agent.id : (pane?.agentId ?? null)}
            name={agent?.name}
            accent={accent}
            size={16}
          />
          <span className="min-w-0 flex-1 truncate text-small font-medium text-dim">
            {agent?.name ?? "Shell"}
          </span>
          {state !== "idle" ? <StatusDot status={state} /> : null}
        </div>
        {brief ? (
          <span className="line-clamp-3 min-w-0 break-words text-small leading-snug text-foreground/80">
            {brief}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 gap-1"
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
            status={status}
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
