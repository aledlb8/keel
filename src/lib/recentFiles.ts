/**
 * Files (and the folders that contain them) touched in the last few minutes.
 *
 * Stamps live at module scope so switching the inspector's root does not wipe
 * the dots on a project you still have open.
 */

export const RECENT_MS = 5 * 60 * 1000;

const stamps = new Map<string, Map<string, number>>();

function parentOf(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx <= 0 ? "" : rel.slice(0, idx);
}

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Stamp these posix rels (and each ancestor folder) for `root` at `now`. */
export function noteRecent(root: string, rels: string[], now?: number): void {
  const t = now ?? Date.now();
  let map = stamps.get(root);
  for (const raw of rels) {
    const rel = normalizeRel(raw);
    if (!rel) continue;
    if (!map) {
      map = new Map();
      stamps.set(root, map);
    }
    map.set(rel, t);
    let parent = parentOf(rel);
    while (parent) {
      map.set(parent, Math.max(map.get(parent) ?? 0, t));
      parent = parentOf(parent);
    }
  }
}

/** Epoch ms the rel was last touched, or 0. */
export function recentAt(root: string, rel: string): number {
  return stamps.get(root)?.get(normalizeRel(rel)) ?? 0;
}

export function isRecent(root: string, rel: string, now?: number): boolean {
  const at = recentAt(root, rel);
  if (!at) return false;
  return (now ?? Date.now()) - at < RECENT_MS;
}

/** Folders containing a recent file. */
export function recentFolders(root: string, now?: number): Set<string> {
  const t = now ?? Date.now();
  const folders = new Set<string>();
  const map = stamps.get(root);
  if (!map) return folders;
  for (const [rel, at] of map) {
    if (!rel || t - at >= RECENT_MS) continue;
    let parent = parentOf(rel);
    while (parent) {
      folders.add(parent);
      parent = parentOf(parent);
    }
  }
  return folders;
}

export function pruneRecent(now?: number): void {
  const t = now ?? Date.now();
  for (const [root, map] of stamps) {
    for (const [rel, at] of map) {
      if (t - at >= RECENT_MS) map.delete(rel);
    }
    if (map.size === 0) stamps.delete(root);
  }
}

export function clearRecent(root: string): void {
  stamps.delete(root);
}
