/**
 * The layout tree — the same model i3, tmux and Hyprland use.
 *
 * Every function here is pure and returns a new tree. Nothing in this file knows
 * about React, terminals or processes; it is only ever splitting rectangles.
 */

import type { Direction, LayoutNode } from "./types";

let counter = 0;
export function nodeId(prefix = "n"): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function paneLeaf(paneId: string): LayoutNode {
  return { kind: "pane", id: paneId };
}

/** Every pane id in the tree, left to right, top to bottom. */
export function listPanes(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.kind === "pane") return [node.id];
  return node.children.flatMap(listPanes);
}

export function hasPane(node: LayoutNode | null, paneId: string): boolean {
  return listPanes(node).includes(paneId);
}

/** The chain of splits from the root down to a pane, outermost first. */
function pathTo(
  node: LayoutNode,
  paneId: string,
  trail: { split: Extract<LayoutNode, { kind: "split" }>; index: number }[] = [],
): { split: Extract<LayoutNode, { kind: "split" }>; index: number }[] | null {
  if (node.kind === "pane") return node.id === paneId ? trail : null;
  for (let index = 0; index < node.children.length; index += 1) {
    const found = pathTo(node.children[index], paneId, [
      ...trail,
      { split: node, index },
    ]);
    if (found) return found;
  }
  return null;
}

function replace(
  node: LayoutNode,
  targetId: string,
  next: LayoutNode | null,
): LayoutNode | null {
  if (node.id === targetId) return next;
  if (node.kind === "pane") return node;

  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const replaced = replace(child, targetId, next);
    if (replaced) {
      children.push(replaced);
      sizes.push(node.sizes[index]);
    }
  });

  if (children.length === 0) return null;
  // A split with one child is just that child — collapse it away so the tree
  // never accumulates invisible wrappers.
  if (children.length === 1) return children[0];
  return { ...node, children, sizes: normalise(sizes) };
}

function normalise(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return sizes.map(() => 1 / sizes.length);
  return sizes.map((size) => size / total);
}

/**
 * Split a pane, putting `newPaneId` beside it.
 *
 * If the pane already sits in a split running the same way, the new pane joins
 * that split as a sibling rather than nesting — otherwise a row of four panes
 * would end up four levels deep and resize like a staircase.
 */
export function splitPane(
  tree: LayoutNode,
  paneId: string,
  direction: Direction,
  newPaneId: string,
): LayoutNode {
  const trail = pathTo(tree, paneId, []);
  const parent = trail?.[trail.length - 1];

  if (parent && parent.split.direction === direction) {
    const { split, index } = parent;
    const children = [...split.children];
    children.splice(index + 1, 0, paneLeaf(newPaneId));

    // Halve the split pane's share and give the other half to the newcomer.
    const sizes = [...split.sizes];
    const share = sizes[index] / 2;
    sizes[index] = share;
    sizes.splice(index + 1, 0, share);

    const rebuilt: LayoutNode = { ...split, children, sizes };
    const replaced = replace(tree, split.id, rebuilt);
    return replaced ?? rebuilt;
  }

  const wrapper: LayoutNode = {
    kind: "split",
    id: nodeId("s"),
    direction,
    children: [paneLeaf(paneId), paneLeaf(newPaneId)],
    sizes: [0.5, 0.5],
  };
  return replace(tree, paneId, wrapper) ?? wrapper;
}

export function closePane(
  tree: LayoutNode | null,
  paneId: string,
): LayoutNode | null {
  if (!tree) return null;
  return replace(tree, paneId, null);
}

/** Drag a seam: move `delta` (a fraction of the split) across one boundary. */
export function resizeSplit(
  tree: LayoutNode,
  splitId: string,
  seam: number,
  delta: number,
): LayoutNode {
  const apply = (node: LayoutNode): LayoutNode => {
    if (node.kind === "pane") return node;
    if (node.id !== splitId) {
      return { ...node, children: node.children.map(apply) };
    }
    const sizes = [...node.sizes];
    const min = 0.06;
    const before = sizes[seam];
    const after = sizes[seam + 1];
    const moved = Math.max(
      Math.min(delta, after - min),
      -(before - min),
    );
    sizes[seam] = before + moved;
    sizes[seam + 1] = after - moved;
    return { ...node, sizes };
  };
  return apply(tree);
}

/** Even out one split's children — the "rebalance" half of close-and-rebalance. */
export function balance(node: LayoutNode): LayoutNode {
  if (node.kind === "pane") return node;
  return {
    ...node,
    sizes: node.children.map(() => 1 / node.children.length),
    children: node.children.map(balance),
  };
}

export type MoveDirection = "left" | "right" | "up" | "down";

const axisOf: Record<MoveDirection, Direction> = {
  left: "row",
  right: "row",
  up: "column",
  down: "column",
};

/** Put a leaf into an existing split at a given position. */
function insertInto(
  tree: LayoutNode,
  splitId: string,
  at: number,
  leaf: LayoutNode,
): LayoutNode | null {
  const host = findSplit(tree, splitId);
  if (!host) return null;

  const children = [...host.children];
  const sizes = [...host.sizes];
  const index = Math.max(0, Math.min(at, children.length));
  children.splice(index, 0, leaf);
  // The newcomer takes an even share; the rest keep their proportions.
  sizes.splice(index, 0, 1 / children.length);

  const rebuilt: LayoutNode = {
    ...host,
    children,
    sizes: normalise(sizes),
  };
  return replace(tree, splitId, rebuilt) ?? rebuilt;
}

/**
 * Move a pane one slot toward `direction` — the i3 `move` gesture.
 *
 * Walking outward from the pane, we look for the nearest split running along
 * that axis where there is somewhere to go. What happens then depends on the
 * neighbour:
 *
 * - **A neighbouring pane** swaps places with this one.
 * - **A neighbouring group** is entered, at the edge nearest the pane — moving
 *   down out of the top row lands you at the start of the row below, rather than
 *   shoving a full-width pane between the two.
 *
 * At the outermost edge nothing happens. The earlier version wrapped the whole
 * root in a new split so the move could always "succeed", which meant one arrow
 * press could hand a single pane half the screen.
 */
export function movePane(
  tree: LayoutNode,
  paneId: string,
  direction: MoveDirection,
): LayoutNode {
  const trail = pathTo(tree, paneId, []);
  if (!trail || trail.length === 0) return tree;

  const axis = axisOf[direction];
  const step = direction === "left" || direction === "up" ? -1 : 1;

  for (let depth = trail.length - 1; depth >= 0; depth -= 1) {
    const { split, index } = trail[depth];
    if (split.direction !== axis) continue;

    const target = index + step;
    if (target < 0 || target >= split.children.length) continue;

    const neighbour = split.children[target];
    const isDirectChild = depth === trail.length - 1;

    // Two panes side by side: trade places.
    if (neighbour.kind === "pane" && isDirectChild) {
      const children = [...split.children];
      const sizes = [...split.sizes];
      [children[index], children[target]] = [children[target], children[index]];
      [sizes[index], sizes[target]] = [sizes[target], sizes[index]];
      const rebuilt: LayoutNode = { ...split, children, sizes };
      return replace(tree, split.id, rebuilt) ?? tree;
    }

    // Otherwise lift the pane out and put it back down in the right place.
    const pruned = replace(tree, paneId, null);
    if (!pruned) return tree;

    const moved =
      neighbour.kind === "split"
        ? // Enter the group at the edge we are arriving from.
          insertInto(
            pruned,
            neighbour.id,
            step === -1 ? neighbour.children.length : 0,
            paneLeaf(paneId),
          )
        : insertInto(
            pruned,
            split.id,
            step === -1 ? index - 1 : index + 1,
            paneLeaf(paneId),
          );

    return moved ?? tree;
  }

  // Already at the outermost edge along this axis.
  return tree;
}

function findSplit(
  node: LayoutNode,
  splitId: string,
): Extract<LayoutNode, { kind: "split" }> | null {
  if (node.kind === "pane") return null;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const found = findSplit(child, splitId);
    if (found) return found;
  }
  return null;
}

/**
 * Build a balanced grid from a flat list of panes — how six agents opened at once
 * become a layout without the user placing anything by hand.
 */
export function gridOf(paneIds: string[]): LayoutNode | null {
  if (paneIds.length === 0) return null;
  if (paneIds.length === 1) return paneLeaf(paneIds[0]);

  const columns = Math.ceil(Math.sqrt(paneIds.length));
  const rows: string[][] = [];
  for (let index = 0; index < paneIds.length; index += columns) {
    rows.push(paneIds.slice(index, index + columns));
  }

  const rowNodes: LayoutNode[] = rows.map((row) =>
    row.length === 1
      ? paneLeaf(row[0])
      : {
          kind: "split",
          id: nodeId("s"),
          direction: "row",
          children: row.map(paneLeaf),
          sizes: row.map(() => 1 / row.length),
        },
  );

  if (rowNodes.length === 1) return rowNodes[0];
  return {
    kind: "split",
    id: nodeId("s"),
    direction: "column",
    children: rowNodes,
    sizes: rowNodes.map(() => 1 / rowNodes.length),
  };
}

/** Focus follows geometry: the pane after/before this one in reading order. */
export function neighbourPane(
  tree: LayoutNode | null,
  paneId: string,
  step: 1 | -1,
): string | null {
  const panes = listPanes(tree);
  if (panes.length === 0) return null;
  const index = panes.indexOf(paneId);
  if (index === -1) return panes[0];
  return panes[(index + step + panes.length) % panes.length];
}
