/** Project files and git, as Rust exposes them. */

import { invoke } from "./invoke.ts";

export interface WorkspaceEntry {
  name: string;
  rel: string;
  kind: "file" | "dir";
  size: number | null;
}

export interface FileContents {
  text: string;
  binary: boolean;
  truncated: boolean;
  size: number;
  mtimeMs: number;
}

/**
 * Children of a project folder. `null` means the path is no longer a folder:
 * the listing must be forgotten, not retried.
 */
export function workspaceList(
  root: string,
  rel: string,
  showHidden = false,
): Promise<WorkspaceEntry[] | null> {
  return invoke("workspace_list", { root, rel, showHidden });
}

export function workspaceRead(root: string, rel: string): Promise<FileContents> {
  return invoke("workspace_read", { root, rel });
}

export function workspaceWrite(
  root: string,
  rel: string,
  contents: string,
  expectedMtimeMs?: number | null,
): Promise<number> {
  return invoke("workspace_write", {
    root,
    rel,
    contents,
    expectedMtimeMs: expectedMtimeMs ?? null,
  });
}

export function workspaceCreate(
  root: string,
  rel: string,
  kind: "file" | "dir",
): Promise<void> {
  return invoke("workspace_create", { root, rel, kind });
}

export function workspaceDelete(root: string, rel: string): Promise<void> {
  return invoke("workspace_delete", { root, rel });
}

export function workspaceRename(
  root: string,
  fromRel: string,
  toRel: string,
): Promise<void> {
  return invoke("workspace_rename", { root, fromRel, toRel });
}

export function workspaceSearch(
  root: string,
  query: string,
): Promise<WorkspaceEntry[]> {
  return invoke("workspace_search", { root, query });
}

export interface GrepHit {
  rel: string;
  line: number;
  /** Where the first match starts, 1-based, in UTF-16 units. */
  column: number;
  /** The first match's length, so the editor can select it. */
  length?: number | undefined;
  text: string;
  /** Every match as `[start, end)` offsets into `text`. */
  ranges?: [number, number][] | undefined;
  /** What each match becomes, when a replacement was asked for. */
  replacements?: string[] | null | undefined;
}

export interface GrepResults {
  hits: GrepHit[];
  truncated: boolean;
  filesSearched?: number | undefined;
  elapsedMs?: number | undefined;
  /** A newer search took over before this one finished. */
  cancelled?: boolean | undefined;
}

export interface GrepOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Comma-separated globs; only matching files are searched. */
  include: string;
  /** Comma-separated globs to leave out. */
  exclude: string;
  /** Hidden, gitignored and build folders too. */
  includeIgnored: boolean;
}

export const DEFAULT_GREP_OPTIONS: GrepOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: "",
  exclude: "",
  includeIgnored: false,
};

export function workspaceGrep(
  root: string,
  query: string,
  options: Partial<GrepOptions> = {},
  replace: string | null = null,
): Promise<GrepResults> {
  return invoke("workspace_grep", {
    root,
    query,
    options: { ...DEFAULT_GREP_OPTIONS, ...options },
    replace,
  });
}

export interface ReplaceTarget {
  rel: string;
  /** Only these lines; the whole file when absent. */
  lines?: number[] | null;
}

export interface ReplaceSummary {
  files: number;
  replacements: number;
  skipped: string[];
}

export function workspaceReplace(
  root: string,
  query: string,
  options: GrepOptions,
  replacement: string,
  targets: ReplaceTarget[],
): Promise<ReplaceSummary> {
  return invoke("workspace_replace", { root, query, options, replacement, targets });
}

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflict"
  | "typechange";

/** Lines a change adds and removes. A binary file counts neither. */
export interface LineStat {
  added: number;
  removed: number;
  binary: boolean;
}

export interface GitFile {
  path: string;
  origPath: string | null;
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflict: boolean;
  /** The working tree against the index, or the whole file when untracked. */
  stat?: LineStat | null | undefined;
  /** The index against HEAD. */
  stagedStat?: LineStat | null | undefined;
}

/** Something that stopped halfway and is waiting to be finished or abandoned. */
export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert";

export interface GitStatus {
  git: boolean;
  repo: boolean;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  /** HEAD's short hash; null before the first commit. */
  head?: string | null | undefined;
  operation?: GitOperation | null | undefined;
  stashes?: number | undefined;
  /** Unix seconds. */
  lastFetch?: number | null | undefined;
  /** There is somewhere to push to and pull from. */
  hasRemote?: boolean | undefined;
}

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface GitHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface GitDiff {
  path: string;
  binary: boolean;
  hunks: GitHunk[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  /** Its upstream was deleted on the remote. */
  gone: boolean;
  ahead: number;
  behind: number;
  /** The tip's committer date, unix seconds. */
  timestamp: number;
  subject: string;
}

export interface GitBranches {
  current: string | null;
  detached: boolean;
  items: GitBranch[];
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  subject: string;
  timestamp: number;
  parents: string[];
  /** As `git log` decorates: `HEAD -> main`, `origin/main`, `tag: v1`. */
  refs: string[];
  /** On no remote-tracking branch yet. */
  unpushed: boolean;
}

export interface CommitFile {
  path: string;
  origPath: string | null;
  status: GitFileStatus;
  stat: LineStat | null;
}

export interface CommitDetails {
  hash: string;
  short: string;
  author: string;
  email: string;
  timestamp: number;
  committer: string;
  commitTimestamp: number;
  subject: string;
  body: string;
  parents: string[];
  files: CommitFile[];
  truncated: boolean;
}

export interface GitStash {
  index: number;
  hash: string;
  message: string;
  branch: string | null;
  timestamp: number;
}

export interface GitTag {
  name: string;
  hash: string;
  annotated: boolean;
  subject: string;
  timestamp: number;
}

export interface GitRemote {
  name: string;
  url: string;
}

export interface PrChecks {
  passed: number;
  failed: number;
  pending: number;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  author: string;
  head: string;
  base: string;
  updatedAt?: string | null | undefined;
  review?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null | undefined;
  checks?: PrChecks | null | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface PrList {
  available: boolean;
  items: PullRequest[];
  error: string | null;
}

export function gitStatus(root: string): Promise<GitStatus> {
  return invoke("git_status", { root });
}

/** Context lines that stand for "the whole file". */
export const FULL_CONTEXT = 1_000_000;

export function gitDiff(
  root: string,
  path: string,
  staged: boolean,
  context = 3,
): Promise<GitDiff> {
  return invoke("git_diff", { root, path, staged, context });
}

/**
 * The file as last committed, for the editor's change gutter. `""` when git
 * would pick the file up but has never committed it; `null` when there is
 * nothing to compare with (no repo, ignored, binary or too big).
 */
export function gitBase(root: string, path: string): Promise<string | null> {
  return invoke("git_base", { root, path });
}

export function gitStage(root: string, paths: string[]): Promise<void> {
  return invoke("git_stage", { root, paths });
}

export function gitUnstage(root: string, paths: string[]): Promise<void> {
  return invoke("git_unstage", { root, paths });
}

export function gitDiscard(root: string, paths: string[]): Promise<void> {
  return invoke("git_discard", { root, paths });
}

export interface CommitOptions {
  amend: boolean;
  signoff: boolean;
  noVerify: boolean;
}

export function gitCommit(
  root: string,
  message: string,
  options?: CommitOptions,
): Promise<string> {
  return invoke("git_commit", { root, message, options: options ?? null });
}

export function gitPush(root: string, setUpstream = false, force = false): Promise<string> {
  return invoke("git_push", { root, setUpstream, force });
}

export type PullMode = "ff-only" | "rebase" | "merge";

export function gitPull(root: string, mode: PullMode = "ff-only"): Promise<string> {
  return invoke("git_pull", { root, mode });
}

export function gitFetch(root: string): Promise<string> {
  return invoke("git_fetch", { root });
}

export function gitBranches(root: string): Promise<GitBranches> {
  return invoke("git_branches", { root });
}

export function gitCheckout(root: string, name: string): Promise<void> {
  return invoke("git_checkout", { root, name });
}

export function gitCheckoutRemote(root: string, name: string): Promise<string> {
  return invoke("git_checkout_remote", { root, name });
}

export function gitCheckoutRev(root: string, rev: string): Promise<string> {
  return invoke("git_checkout_rev", { root, rev });
}

export function gitBranchRename(root: string, from: string, to: string): Promise<string> {
  return invoke("git_branch_rename", { root, from, to });
}

export function gitBranchDeleteRemote(root: string, name: string): Promise<string> {
  return invoke("git_branch_delete_remote", { root, name });
}

export type MergeMode = "default" | "no-ff" | "ff-only" | "squash";

export function gitMerge(root: string, name: string, mode: MergeMode = "default"): Promise<string> {
  return invoke("git_merge", { root, name, mode });
}

export function gitRebase(root: string, onto: string): Promise<string> {
  return invoke("git_rebase", { root, onto });
}

export function gitCherryPick(root: string, rev: string): Promise<string> {
  return invoke("git_cherry_pick", { root, rev });
}

export function gitRevert(root: string, rev: string): Promise<string> {
  return invoke("git_revert", { root, rev });
}

export type ResetMode = "soft" | "mixed" | "hard";

export function gitReset(root: string, rev: string, mode: ResetMode): Promise<string> {
  return invoke("git_reset", { root, rev, mode });
}

export type OperationAction = "continue" | "abort" | "skip";

export function gitOperation(root: string, action: OperationAction): Promise<string> {
  return invoke("git_operation", { root, action });
}

export function gitResolve(
  root: string,
  paths: string[],
  side: "ours" | "theirs",
): Promise<void> {
  return invoke("git_resolve", { root, paths, side });
}

export function gitIgnore(root: string, pattern: string): Promise<void> {
  return invoke("git_ignore", { root, pattern });
}

export function gitHeadMessage(root: string): Promise<string> {
  return invoke("git_head_message", { root });
}

/** Take back the last commit, keeping its changes. Resolves to its message. */
export function gitUndoCommit(root: string): Promise<string> {
  return invoke("git_undo_commit", { root });
}

export function gitCommitDetails(root: string, rev: string): Promise<CommitDetails> {
  return invoke("git_commit_details", { root, rev });
}

export function gitDiffRev(
  root: string,
  rev: string,
  path: string,
  origPath: string | null = null,
  context = 3,
): Promise<GitDiff> {
  return invoke("git_diff_rev", { root, rev, path, origPath, context });
}

export function gitStashList(root: string): Promise<GitStash[]> {
  return invoke("git_stash_list", { root });
}

export function gitStashPush(
  root: string,
  args: { message?: string | null; includeUntracked: boolean; paths?: string[] | null },
): Promise<string> {
  return invoke("git_stash_push", {
    root,
    message: args.message ?? null,
    includeUntracked: args.includeUntracked,
    paths: args.paths ?? null,
  });
}

export function gitStashApply(root: string, stash: GitStash, pop: boolean): Promise<string> {
  return invoke("git_stash_apply", { root, index: stash.index, hash: stash.hash, pop });
}

export function gitStashDrop(root: string, stash: GitStash): Promise<string> {
  return invoke("git_stash_drop", { root, index: stash.index, hash: stash.hash });
}

export function gitTags(root: string): Promise<GitTag[]> {
  return invoke("git_tags", { root });
}

export function gitTagCreate(
  root: string,
  name: string,
  rev: string,
  message: string | null = null,
): Promise<string> {
  return invoke("git_tag_create", { root, name, rev, message });
}

export function gitTagDelete(root: string, name: string): Promise<string> {
  return invoke("git_tag_delete", { root, name });
}

export function gitTagPush(root: string, name: string): Promise<string> {
  return invoke("git_tag_push", { root, name });
}

export interface LineSelection {
  /** Which hunk, in the order the diff lists them. */
  hunk: number;
  /** Indices into that hunk's lines; the whole hunk when absent. */
  lines?: number[] | null;
}

export type LineAction = "stage" | "unstage" | "discard";

/**
 * Stage, unstage or discard some hunks or lines of one file. `headers` are
 * the hunk headers the selection was made against, so a diff that changed
 * underneath is refused rather than misapplied.
 */
export function gitApplyLines(
  root: string,
  path: string,
  action: LineAction,
  selection: LineSelection[],
  headers: string[],
  context = 3,
): Promise<string> {
  return invoke("git_apply_lines", { root, path, action, selection, headers, context });
}

export function gitInit(root: string): Promise<void> {
  return invoke("git_init", { root });
}

export function gitRemotes(root: string): Promise<GitRemote[]> {
  return invoke("git_remotes", { root });
}

export function gitBranchCreate(
  root: string,
  name: string,
  checkout: boolean,
  start: string | null = null,
): Promise<void> {
  return invoke("git_branch_create", { root, name, checkout, start });
}

export function gitBranchDelete(root: string, name: string, force = false): Promise<void> {
  return invoke("git_branch_delete", { root, name, force });
}

export interface LogOptions {
  skip?: number;
  /** Every branch, remote and tag rather than just HEAD. */
  all?: boolean;
  query?: string | null;
}

export function gitLog(root: string, limit = 30, options: LogOptions = {}): Promise<GitCommit[]> {
  return invoke("git_log", {
    root,
    limit,
    options: { skip: options.skip ?? 0, all: options.all ?? false, query: options.query ?? null },
  });
}

export function prList(root: string): Promise<PrList> {
  return invoke("pr_list", { root });
}

export function prCreate(
  root: string,
  args: { title: string; body: string; base?: string | null; draft: boolean },
): Promise<PullRequest> {
  return invoke("pr_create", {
    root,
    title: args.title,
    body: args.body,
    base: args.base ?? null,
    draft: args.draft,
  });
}

export function prCheckout(root: string, number: number): Promise<void> {
  return invoke("pr_checkout", { root, number });
}
