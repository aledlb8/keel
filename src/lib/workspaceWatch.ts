/**
 * Subscribe to project-folder changes from the Rust watcher.
 *
 * Events are already debounced. `rels: [""]` means refresh the whole tree;
 * `git` means ask git again — never run git from the notify thread.
 */

import { listen } from "@tauri-apps/api/event";

import { invoke } from "./invoke.ts";

export interface WorkspaceChanged {
  root: string;
  rels: string[];
  git: boolean;
}

/** Compare two project paths the way the watcher round-trips them. */
export function sameWatchRoot(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  if (a === b) return true;
  const left = a.replace(/\\/g, "/");
  const right = b.replace(/\\/g, "/");
  if (left === right) return true;
  return left.toLowerCase() === right.toLowerCase();
}

const live = new Set<string>();

export function isWatching(root: string | null | undefined): boolean {
  if (!root) return false;
  for (const path of live) {
    if (sameWatchRoot(root, path)) return true;
  }
  return false;
}

export async function workspaceWatch(root: string): Promise<void> {
  await invoke("workspace_watch", { root });
  live.add(root);
}

export async function workspaceUnwatch(root: string): Promise<void> {
  await invoke("workspace_unwatch", { root });
  live.delete(root);
}

export function onWorkspaceChanged(
  handler: (event: { root: string; rels: string[]; git: boolean }) => void,
): Promise<() => void> {
  return listen<WorkspaceChanged>("workspace:changed", (event) =>
    handler(event.payload),
  );
}
