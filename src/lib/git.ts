/** Pure helpers over git status: grouping, labels, path joins. */

import type { GitDiff, GitFile, GitFileStatus, GitStatus } from "./workspace";

export interface GitGroups {
  conflict: GitFile[];
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: GitFile[];
}

/** A file with both staged and unstaged hunks appears in both lists. */
export function groupGitFiles(files: GitFile[]): GitGroups {
  const conflict: GitFile[] = [];
  const staged: GitFile[] = [];
  const unstaged: GitFile[] = [];
  const untracked: GitFile[] = [];
  for (const file of files) {
    if (file.conflict) {
      conflict.push(file);
      continue;
    }
    if (file.untracked) {
      untracked.push(file);
      continue;
    }
    if (file.staged) staged.push(file);
    if (file.unstaged) unstaged.push(file);
  }
  return { conflict, staged, unstaged, untracked };
}

/** How many changes there are, counting any the status list left out. */
export function changeCount(git: GitStatus): number {
  return git.fileCount ?? git.files.length;
}

/** The status list was cut short; actions on "everything" must not use it. */
export function changesTruncated(git: GitStatus): boolean {
  return changeCount(git) > git.files.length;
}

export function gitLetter(status: GitFileStatus): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "U";
    case "conflict":
      return "!";
    case "typechange":
      return "T";
    default:
      return "M";
  }
}

/** The status in words, for tooltips and screen readers. */
export function gitStatusLabel(status: GitFileStatus): string {
  switch (status) {
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "untracked":
      return "Untracked";
    case "conflict":
      return "Conflict";
    case "typechange":
      return "Type changed";
    default:
      return "Modified";
  }
}

/** Status colour as a CSS custom property — tints the chip and the row's name. */
export function gitStatusColor(status: GitFileStatus): string {
  switch (status) {
    case "added":
    case "untracked":
      return "var(--keel-done)";
    case "deleted":
    case "conflict":
      return "var(--keel-dead)";
    case "renamed":
    case "copied":
      return "var(--keel-ansi-magenta)";
    default:
      return "var(--keel-working)";
  }
}

export function joinRel(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split(/[\\/]/))
    .filter((part) => part && part !== ".")
    .join("/");
}

export function parentRel(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx <= 0 ? "" : rel.slice(0, idx);
}

export function fileName(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx < 0 ? rel : rel.slice(idx + 1);
}

export function aheadBehind(ahead: number, behind: number): string | null {
  if (!ahead && !behind) return null;
  if (ahead && behind) return `${ahead} ahead, ${behind} behind`;
  if (ahead) return `${ahead} ahead`;
  return `${behind} behind`;
}

/** Map of path → status for decorating the file tree. Prefers conflict, then unstaged. */
export function gitBadgeMap(files: GitFile[]): Record<string, GitFileStatus> {
  const map: Record<string, GitFileStatus> = {};
  for (const file of files) {
    const current = map[file.path];
    if (!current || file.conflict || (file.unstaged && current !== "conflict")) {
      map[file.path] = file.status;
    }
    if (file.origPath && !map[file.origPath]) {
      map[file.origPath] = file.status;
    }
  }
  return map;
}

/** Which status speaks for a folder when its children disagree. Trouble first. */
const SEVERITY: Record<GitFileStatus, number> = {
  conflict: 6,
  deleted: 5,
  modified: 4,
  typechange: 4,
  renamed: 3,
  copied: 3,
  added: 2,
  untracked: 1,
};

/**
 * Every folder with a change somewhere inside it, and the status that stands
 * for it — the worst one below it — so a folded folder can still say so.
 */
export function folderStatuses(files: GitFile[]): Record<string, GitFileStatus> {
  const folders: Record<string, GitFileStatus> = {};
  for (const file of files) {
    let parent = parentRel(file.path);
    while (parent) {
      const current = folders[parent];
      if (current && SEVERITY[current] >= SEVERITY[file.status]) break;
      folders[parent] = file.status;
      parent = parentRel(parent);
    }
  }
  return folders;
}

/** Lines added and removed across a whole diff. */
export function diffStats(diff: GitDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added += 1;
      else if (line.kind === "del") removed += 1;
    }
  }
  return { added, removed };
}

/** "@@ -12,6 +12,8 @@ fn main()" → the line range, and the code git says it sits in. */
export function splitHunkHeader(header: string): { range: string; context: string } {
  const match = /^(@@[^@]*@@)\s*(.*)$/.exec(header);
  if (!match) return { range: header, context: "" };
  return { range: match[1] ?? header, context: (match[2] ?? "").trim() };
}

/** "3h ago", from a unix timestamp in seconds as `git log` prints it. */
export function relativeTime(seconds: number, now = Date.now()): string {
  const elapsed = Math.max(0, Math.round(now / 1000 - seconds));
  if (elapsed < 60) return "just now";
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ---- Change tree ------------------------------------------------------------

export interface ChangeFolder {
  kind: "folder";
  /** Full relative path of the deepest folder this row stands for. */
  path: string;
  /** What the row shows: one folder, or a chain of single-child folders. */
  name: string;
  children: ChangeNode[];
  /** Every file anywhere below, for acting on the folder as a whole. */
  files: GitFile[];
}

export interface ChangeLeaf {
  kind: "file";
  file: GitFile;
}

export type ChangeNode = ChangeFolder | ChangeLeaf;

/**
 * Changes as folders. A folder holding nothing but one other folder folds into
 * it — `src/lib` rather than `src` › `lib` — so a deep change is one row deep.
 */
export function buildChangeTree(files: GitFile[]): ChangeNode[] {
  interface Draft {
    folders: Map<string, Draft>;
    files: GitFile[];
    all: GitFile[];
  }
  const root: Draft = { folders: new Map(), files: [], all: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    parts.pop();
    let node = root;
    node.all.push(file);
    for (const part of parts) {
      let next = node.folders.get(part);
      if (!next) {
        next = { folders: new Map(), files: [], all: [] };
        node.folders.set(part, next);
      }
      next.all.push(file);
      node = next;
    }
    node.files.push(file);
  }

  const build = (draft: Draft, prefix: string): ChangeNode[] => {
    const folders = [...draft.folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([part, child]): ChangeFolder => {
        let name = part;
        let path = prefix ? `${prefix}/${part}` : part;
        let node = child;
        while (node.files.length === 0 && node.folders.size === 1) {
          const [[nextPart, next]] = [...node.folders.entries()] as [[string, Draft]];
          name = `${name}/${nextPart}`;
          path = `${path}/${nextPart}`;
          node = next;
        }
        return { kind: "folder", path, name, children: build(node, path), files: node.all };
      });
    const leaves = [...draft.files]
      .sort((a, b) => fileName(a.path).localeCompare(fileName(b.path)))
      .map((file): ChangeLeaf => ({ kind: "file", file }));
    return [...folders, ...leaves];
  };
  return build(root, "");
}

// ---- Refs and remotes -------------------------------------------------------

export interface RefLabel {
  kind: "head" | "branch" | "remote" | "tag";
  name: string;
  /** The branch HEAD is on. */
  current: boolean;
}

/**
 * A `git log` decoration as a label. Whether `a/b` is a remote branch or a
 * local one with a slash in its name depends on the remotes that exist.
 */
export function parseRef(ref: string, remotes: string[] = ["origin"]): RefLabel {
  if (ref === "HEAD") return { kind: "head", name: "HEAD", current: true };
  if (ref.startsWith("HEAD -> ")) {
    return { kind: "branch", name: ref.slice("HEAD -> ".length), current: true };
  }
  if (ref.startsWith("tag: ")) return { kind: "tag", name: ref.slice(5), current: false };
  const remote = remotes.some((name) => ref.startsWith(`${name}/`));
  return { kind: remote ? "remote" : "branch", name: ref, current: false };
}

/** The browsable page of a remote, for GitHub, GitLab and the like. */
export function remoteWebUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "").replace(/\/$/, "");
  // git@github.com:owner/repo
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const parsed = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(trimmed);
  if (parsed) return `https://${parsed[1]}/${parsed[2]}`;
  return null;
}

/** "feat(ui): x" → "feat"; anything else → null. */
export function conventionalType(subject: string): string | null {
  const match = /^([a-z]+)(\([^)]*\))?!?:\s/.exec(subject);
  return match?.[1] ?? null;
}

/** First line, and how far over git's 50- and 72-column habits it runs. */
export function subjectLength(message: string): { length: number; level: "ok" | "long" | "over" } {
  const length = (message.split("\n")[0] ?? "").length;
  return { length, level: length > 72 ? "over" : length > 50 ? "long" : "ok" };
}

/** A hue that stays the same for the same name, for an author's monogram. */
export function nameHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}
