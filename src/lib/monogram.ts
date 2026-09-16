/**
 * A name, shortened to the two letters that still tell it apart.
 *
 * The rail and the workspace marks have room for a glyph, not a label, and a
 * drawn glyph cannot say *which* project or *which* group. Initials can.
 */

/** Two initials for a multi-word name, else the first two letters: "Ke", "MA". */
export function monogram(name: string): string {
  const [first = "", second = ""] = name.split(/[\s._-]+/).filter(Boolean);
  if (second) return (first.charAt(0) + second.charAt(0)).toUpperCase();
  return first.charAt(0).toUpperCase() + first.charAt(1).toLowerCase();
}
