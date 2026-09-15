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
}

export function workspaceList(
  root: string,
  rel: string,
  showHidden = false,
): Promise<WorkspaceEntry[]> {
  return invoke("workspace_list", { root, rel, showHidden });
}

export function workspaceRead(root: string, rel: string): Promise<FileContents> {
  return invoke("workspace_read", { root, rel });
}

export function workspaceWrite(
  root: string,
  rel: string,
  contents: string,
): Promise<void> {
  return invoke("workspace_write", { root, rel, contents });
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

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflict"
  | "typechange";

export interface GitFile {
  path: string;
  origPath: string | null;
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflict: boolean;
}

export interface GitStatus {
  git: boolean;
  repo: boolean;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
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
  subject: string;
  timestamp: number;
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
}

export interface PrList {
  available: boolean;
  items: PullRequest[];
  error: string | null;
}

export function gitStatus(root: string): Promise<GitStatus> {
  return invoke("git_status", { root });
}

export function gitDiff(
  root: string,
  path: string,
  staged: boolean,
): Promise<GitDiff> {
  return invoke("git_diff", { root, path, staged });
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

export function gitCommit(root: string, message: string): Promise<string> {
  return invoke("git_commit", { root, message });
}

export function gitPush(root: string, setUpstream = false): Promise<string> {
  return invoke("git_push", { root, setUpstream });
}

export function gitPull(root: string): Promise<string> {
  return invoke("git_pull", { root });
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

export function gitBranchCreate(
  root: string,
  name: string,
  checkout: boolean,
): Promise<void> {
  return invoke("git_branch_create", { root, name, checkout });
}

export function gitBranchDelete(root: string, name: string): Promise<void> {
  return invoke("git_branch_delete", { root, name });
}

export function gitLog(root: string, limit = 30): Promise<GitCommit[]> {
  return invoke("git_log", { root, limit });
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
