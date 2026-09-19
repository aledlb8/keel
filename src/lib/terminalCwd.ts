/**
 * Where the shell is, said by the shell itself.
 *
 * A shell can announce its folder on every prompt with an escape sequence:
 * `OSC 9 ; 9 ; <path>` — the ConEmu form Windows Terminal also takes, and the
 * one a Windows path can be spoken in directly — and `OSC 7 ; file://…` — the
 * POSIX form shell-integration scripts usually emit. xterm reassembles the
 * sequence and hands the payload over; the helpers here decide whether a
 * payload names a local absolute directory worth remembering.
 *
 * Anything else is refused, without exception. Prompt output is free-form by
 * construction: an agent, a banner, or a half-finished program can push any
 * bytes at the parser, and a pane must never adopt a relative path, a URL
 * from another machine, or a payload carrying control characters.
 */

/** Control characters in a payload are never a real folder name. */
const CONTROLS = /[\u0000-\u001F\u007F]/;

/** `C:\…`, either separator. POSIX absolute paths start with a plain `/`. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** UNC shares start with two separators: `\\host\share`. */
const UNC_SHARE = /^[\\/]{2}/;

/** ConEmu quotes the path in double quotes; accept both spellings. */
function unquoted(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function decoded(url: URL): string | null {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

/** The `9;9` payload: the raw path, possibly quoted. */
export function cwdFromOsc99(data: string): string | null {
  const path = unquoted(data);
  if (!path || CONTROLS.test(path)) return null;
  if (
    !WINDOWS_DRIVE.test(path) &&
    !UNC_SHARE.test(path) &&
    !path.startsWith("/")
  ) {
    return null;
  }
  return path;
}

/** The `7` payload: a `file:` URL. */
export function cwdFromOsc7(data: string): string | null {
  const text = data.trim();
  if (!text || CONTROLS.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;

  // A folder on another machine is not one this pane can reopen in.
  const host = url.hostname;
  const path = decoded(url);
  if (!path || CONTROLS.test(path)) return null;

  if (host) {
    if (host !== "localhost") return null;
    // `file://localhost/C:/…` is just a spelled-out empty authority.
    if (WINDOWS_DRIVE.test(path.slice(1))) {
      return path.slice(1).replace(/\//g, "\\");
    }
    if (path.startsWith("/")) return path;
    return null;
  }

  // `file:///C:/…` carries the drive as the first path segment.
  if (WINDOWS_DRIVE.test(path.slice(1))) {
    return path.slice(1).replace(/\//g, "\\");
  }
  if (!path.startsWith("/")) return null;
  return path;
}

/**
 * True when `dir` is the root itself or sits inside it.
 *
 * Windows paths ignore case and take both separators; POSIX paths do not.
 * The comparison runs on segments so a sibling with a shared prefix —
 * `keel` beside `keel-www` — is never mistaken for being inside.
 */
export function pathWithin(dir: string, root: string): boolean {
  const segments = (path: string) =>
    path
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part !== "");

  const here = segments(dir);
  const home = segments(root);
  if (home.length === 0 || home.length > here.length) return false;

  const windows = WINDOWS_DRIVE.test(root) || UNC_SHARE.test(root);
  for (let index = 0; index < home.length; index += 1) {
    const a = here[index] ?? "";
    const b = home[index] ?? "";
    if (windows ? a.toLowerCase() !== b.toLowerCase() : a !== b) {
      return false;
    }
  }
  return true;
}
