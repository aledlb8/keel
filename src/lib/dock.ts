/**
 * Where a dragged pane would land, from where the pointer is.
 *
 * Over any pane, three kinds of place:
 *
 *  - **The middle** swaps the two panes.
 *  - **A band along each edge** docks against that pane.
 *  - **Thin strips right at an edge** dock against a whole group instead: every
 *    group whose outline shares that edge with the pane gets a strip, the
 *    outermost one — the entire layout — nearest the edge. That is how a pane
 *    goes full width along the bottom, or full height down the side.
 *
 * Kept apart from the canvas so the geometry can be tested on its own.
 */

import {
  ancestorsOf,
  dockShare,
  listPanes,
  type DropEdge,
} from "./tree.ts";
import type { LayoutNode } from "./types";

export type DropZone = DropEdge | "center";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where a drop lands: against which node, on which side, covering what. */
export interface DropTarget {
  /** A pane id, or a split id for a group. */
  nodeId: string;
  zone: DropZone;
  /** The part of the canvas the pane will take, for the highlight. */
  box: Box;
}

/** How deep, as a fraction of the pane, each edge's docking band reaches. */
const EDGE_BAND = 0.28;

/** How thick, in pixels, one group's strip is. */
const GROUP_STRIP = 18;

/** Half the gutter: a pointer in the gap between panes still counts. */
const GAP_SLOP = 6;

const EDGES: DropEdge[] = ["left", "right", "top", "bottom"];

export function dropZoneAt(box: Box, x: number, y: number): DropZone {
  if (box.width <= 0 || box.height <= 0) return "center";
  const fx = (x - box.left) / box.width;
  const fy = (y - box.top) / box.height;

  const edges: [DropEdge, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  const [edge, distance] = edges.reduce((nearest, candidate) =>
    candidate[1] < nearest[1] ? candidate : nearest,
  );
  return distance < EDGE_BAND ? edge : "center";
}

/** The part of `box` a pane docked against `zone` will take. */
export function zoneBox(box: Box, zone: DropZone, share = 0.5): Box {
  const width = box.width * share;
  const height = box.height * share;
  switch (zone) {
    case "left":
      return { ...box, width };
    case "right":
      return { ...box, left: box.left + box.width - width, width };
    case "top":
      return { ...box, height };
    case "bottom":
      return { ...box, top: box.top + box.height - height, height };
    case "center":
      return box;
  }
}

/** The pane whose box, grown by `slop` on every side, contains the point. */
export function paneAt(
  boxes: Record<string, Box>,
  x: number,
  y: number,
  slop = 0,
): string | null {
  for (const [id, box] of Object.entries(boxes)) {
    if (
      x >= box.left - slop &&
      x < box.left + box.width + slop &&
      y >= box.top - slop &&
      y < box.top + box.height + slop
    ) {
      return id;
    }
  }
  return null;
}

export function dropTargetAt(
  tree: LayoutNode,
  boxes: Record<string, Box>,
  dragged: string,
  x: number,
  y: number,
): DropTarget | null {
  const paneId = paneAt(boxes, x, y, GAP_SLOP);
  if (!paneId) return null;
  const pane = boxes[paneId];

  // A group strip, if the pointer is in one. Closest edge wins.
  let best: (DropTarget & { distance: number }) | null = null;
  for (const edge of EDGES) {
    const groups = ancestorsOf(tree, paneId)
      .map((split) => ({ split, ids: listPanes(split) }))
      .filter(({ ids }) => ids.some((id) => id !== dragged))
      .map((group) => ({ ...group, box: boundsOf(group.ids, boxes) }))
      .filter(
        (group): group is typeof group & { box: Box } =>
          group.box !== null && sameEdge(group.box, pane, edge),
      );
    if (groups.length === 0) continue;

    const distance = Math.max(0, distanceToEdge(pane, edge, x, y));
    if (distance >= groups.length * GROUP_STRIP) continue;
    if (best && distance >= best.distance) continue;

    // Outermost group in the strip nearest the edge.
    const group = groups[groups.length - 1 - Math.floor(distance / GROUP_STRIP)];
    const others = group.ids.filter((id) => id !== dragged).length;
    best = {
      nodeId: group.split.id,
      zone: edge,
      box: zoneBox(group.box, edge, dockShare(others)),
      distance,
    };
  }
  if (best) {
    const { distance: _, ...target } = best;
    return target;
  }

  // Your own pane only has the group strips; docking against yourself is nothing.
  if (paneId === dragged) return null;
  const zone = dropZoneAt(pane, x, y);
  return { nodeId: paneId, zone, box: zoneBox(pane, zone) };
}

/** The outline around a set of panes. */
function boundsOf(ids: string[], boxes: Record<string, Box>): Box | null {
  const present = ids.map((id) => boxes[id]).filter(Boolean);
  if (present.length === 0) return null;
  const left = Math.min(...present.map((box) => box.left));
  const top = Math.min(...present.map((box) => box.top));
  const right = Math.max(...present.map((box) => box.left + box.width));
  const bottom = Math.max(...present.map((box) => box.top + box.height));
  return { left, top, width: right - left, height: bottom - top };
}

function edgeOf(box: Box, edge: DropEdge): number {
  switch (edge) {
    case "left":
      return box.left;
    case "right":
      return box.left + box.width;
    case "top":
      return box.top;
    case "bottom":
      return box.top + box.height;
  }
}

function sameEdge(outer: Box, inner: Box, edge: DropEdge): boolean {
  return Math.abs(edgeOf(outer, edge) - edgeOf(inner, edge)) < 1;
}

function distanceToEdge(box: Box, edge: DropEdge, x: number, y: number): number {
  switch (edge) {
    case "left":
      return x - box.left;
    case "right":
      return box.left + box.width - x;
    case "top":
      return y - box.top;
    case "bottom":
      return box.top + box.height - y;
  }
}
