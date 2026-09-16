/** List reordering shared by the sidebar's drag and drop and the store. */

/** Swap two indexes in place. No-ops if either is out of range. */
export function swapAt<T>(items: T[], i: number, j: number): void {
  const a = items[i];
  const b = items[j];
  if (a === undefined || b === undefined) return;
  items[i] = b;
  items[j] = a;
}

/**
 * Move the first item matching `match` to `index`, where `index` counts places
 * in the list *without* that item — the position a drop indicator points at.
 * Returns the same array when nothing would change.
 */
export function moveTo<T>(
  items: T[],
  match: (item: T) => boolean,
  index: number,
): T[] {
  const from = items.findIndex(match);
  if (from < 0) return items;
  const item = items[from];
  if (item === undefined) return items;
  const rest = items.filter((_, position) => position !== from);
  const at = Math.max(0, Math.min(index, rest.length));
  if (at === from) return items;
  rest.splice(at, 0, item);
  return rest;
}
