/**
 * Where you are, said the way you would say it out loud.
 *
 * The status bar has room for one short line, and `…/dev/code/keel/src` spends
 * most of it on the part that never changes. The project is already the anchor —
 * you picked it in the sidebar and named it yourself — so name it once and give
 * the rest of the line to the part that actually moves: where the focused
 * terminal has got to inside it.
 *
 * A terminal that has wandered outside its project falls back to the plain tail
 * form, because there the anchor would be a lie.
 */

/** Windows paths compare without case; POSIX ones do not. */
const WINDOWS_ROOT = /^[a-zA-Z]:/;

/** Enough segments to orient you, in the shape a shell prompt would use. */
const KEEP = 3;

export interface StatusPlace {
  /** The project's name, when the path is inside it. */
  root: string | null;
  /** What follows the root, or the whole shortened path when there is none. */
  tail: string | null;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** The last few segments, with a leading ellipsis when anything was dropped. */
function shorten(path: string, lead: string): string {
  const parts = segments(path);
  if (parts.length === 0) return path;
  const tail = parts.slice(-KEEP);
  return (parts.length > tail.length ? `${lead}…/` : lead) + tail.join("/");
}

/** Paths in a status bar are for orientation, not for copying. */
export function shortenPath(path: string): string {
  return shorten(normalize(path), "");
}

export function statusPlace(
  cwd: string | null,
  project: { name: string; path: string } | null,
): StatusPlace {
  const here = cwd ?? project?.path ?? null;
  if (!here) return { root: null, tail: null };
  if (!project) return { root: null, tail: shortenPath(here) };

  const at = normalize(here);
  const root = normalize(project.path);
  const fold = WINDOWS_ROOT.test(root);
  const a = fold ? at.toLowerCase() : at;
  const b = fold ? root.toLowerCase() : root;

  // The trailing slash is what keeps this a path rather than the project name
  // said a second time: the island already told you which project you are in.
  if (a === b) return { root: project.name, tail: "/" };
  if (a.startsWith(`${b}/`)) {
    return { root: project.name, tail: shorten(at.slice(root.length), "/") };
  }
  return { root: null, tail: shortenPath(at) };
}
