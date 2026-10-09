/** Everything else Rust exposes: agent detection, persistence, folders. */

import { invoke } from "./invoke.ts";
import type { Agent, AgentSpec, PersistedState, VpnProfileInfo } from "./types";

export function detectAgents(): Promise<Agent[]> {
  return invoke("detect_agents");
}

/** Replaces the user catalogue and returns the freshly detected agents. */
export function saveAgentCatalogue(agents: AgentSpec[]): Promise<Agent[]> {
  return invoke("agent_catalogue_save", { agents });
}

/** The catalogue as it ships, for resetting a built-in agent. */
export function agentCatalogueDefaults(): Promise<AgentSpec[]> {
  return invoke("agent_catalogue_defaults");
}

/** Creates the user-editable catalogue if it does not exist yet, then returns it. */
export function agentCataloguePath(): Promise<string> {
  return invoke("agent_catalogue_path");
}

/** The chat the Grok process in this pane has open, from Grok's own registry. */
export function grokPaneSession(
  paneId: string,
  accountId: string | null,
): Promise<string | null> {
  return invoke("grok_pane_session", { paneId, accountId });
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

/** Native folder picker. The chosen path is registered as an open project root. */
export function pickProjectFolder(): Promise<string | null> {
  return invoke("project_pick");
}

export interface VpnSnapshot {
  phase: string;
  connectInstalled: boolean;
  openvpnPath: string | null;
  profiles: VpnProfileInfo[];
  profileId: string | null;
  profileName: string | null;
  adapter: string | null;
  tunnelIp: string | null;
  ifIndex: number | null;
  proxyPort: number | null;
  isolated: boolean;
  error: string | null;
}

export function vpnSnapshot(): Promise<VpnSnapshot> {
  return invoke("vpn_snapshot");
}

export function vpnConnect(profileId?: string | null): Promise<VpnSnapshot> {
  return invoke("vpn_connect", { profileId: profileId ?? null });
}

export function vpnDisconnect(): Promise<VpnSnapshot> {
  return invoke("vpn_disconnect");
}