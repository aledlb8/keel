/** List reordering shared by the sidebar's drag and drop and the store. */

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
  const rest = items.filter((_, position) => position !== from);
  const at = Math.max(0, Math.min(index, rest.length));
  if (at === from) return items;
  rest.splice(at, 0, items[from]);
  return rest;
}
