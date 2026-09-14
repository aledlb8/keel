/** Everything else Rust exposes: agent detection, persistence, folders. */

import { invoke } from "@/lib/invoke";
import type { Agent, PersistedState } from "./types";

export function detectAgents(): Promise<Agent[]> {
  return invoke("detect_agents");
}

/** Creates the user-editable catalogue if it does not exist yet, then returns it. */
export function agentCataloguePath(): Promise<string> {
  return invoke("agent_catalogue_path");
}

export function loadState(): Promise<PersistedState | null> {
  return invoke("state_load");
}

export function saveState(state: PersistedState): Promise<void> {
  return invoke("state_save", { state });
}

export function statePath(): Promise<string> {
  return invoke("state_path");
}

export function listSubdirectories(
  path: string,
): Promise<{ name: string; path: string }[]> {
  return invoke("list_subdirectories", { path });
}

export function pathExists(path: string): Promise<boolean> {
  return invoke("path_exists", { path });
}