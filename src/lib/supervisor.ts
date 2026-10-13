/**
 * Every pane's process, started by the main window whatever is on screen.
 *
 * A terminal no longer has to be drawn to run. For each terminal pane the
 * supervisor makes sure its current generation has a process — at launch, when
 * a pane is added, when one is restarted — and windows only ever attach to one
 * that exists. That is what lets a window drop the terminals of decks you are
 * not looking at: their processes, screens and scrollback carry on in Rust.
 *
 * A new process waits while a private VPN tunnel is still coming up, so agent
 * traffic does not leak out of the PC's normal route.
 */

import { toast } from "sonner";

import { applySession } from "./launch.ts";
import { paneSizeHint } from "./paneSize.ts";
import { ptySample, spawnPty } from "./pty.ts";
import type { Pane, Project, VpnState } from "./types.ts";
import { useKeel } from "../state/store.ts";

function networkReady(vpn: VpnState): boolean {
  return vpn.spawnAllowed && !(vpn.autoConnect && vpn.phase === "connecting");
}

/** What a pane runs: the agent's command, resumed if it has a conversation. */
function commandOf(pane: Pane): string | null {
  const agent = useKeel.getState().agents.find((item) => item.id === pane.agentId);
  return pane.resumeAgent && agent
    ? applySession(agent.command, agent.session, {
        sessionId: pane.sessionId,
        sessionReady: pane.sessionReady,
      })
    : null;
}

/** Returns the teardown. Call once, in the main window, after `init`. */
export function startSupervisor(): () => void {
  /** The generation each pane has a process for, or is getting one for. */
  const started = new Map<string, number>();
  /** The command each running pane was last seen with. */
  const commands = new Map<string, string | null>();

  const current = (paneId: string, generation: number) =>
    (useKeel.getState().generations[paneId] ?? 0) === generation;

  const spawn = async (project: Project, pane: Pane, generation: number) => {
    const keel = useKeel.getState();
    const agent = keel.agents.find((item) => item.id === pane.agentId) ?? null;
    const command = commandOf(pane);
    const launchAgentId = command && pane.resumeAgent ? pane.agentId : null;
    commands.set(pane.id, command);
    keel.noteShellSpawn(pane.id, launchAgentId, pane.accountId ?? null);
    keel.noteActivity(pane.id, "spawn");
    const vpn = keel.vpn;
    const proxyPort = vpn.phase === "connected" ? vpn.proxyPort : null;
    try {
      await spawnPty({
        id: pane.id,
        generation,
        cwd: pane.cwd ?? project.path,
        command,
        agentId: launchAgentId,
        accountEnv: agent?.accountEnv ?? null,
        accountId: pane.accountId,
        ...paneSizeHint(pane.id),
      });
      if (!current(pane.id, generation)) return;
      useKeel.getState().noteSpawned(pane.id, { generation, proxyPort });
      useKeel.getState().settleRestore(pane.id, true);
    } catch (error) {
      if (!current(pane.id, generation)) return;
      const reason = String(error).trim() || "The agent process failed to start.";
      useKeel.getState().noteSpawned(pane.id, { generation, proxyPort, error: reason });
      useKeel.getState().noteSpawnFail(pane.id);
      toast.error("Couldn't start agent", {
        description: reason,
        action: {
          label: "Try again",
          onClick: () => useKeel.getState().restartPane(pane.id),
        },
      });
    }
  };

  let seen: unknown[] = [];
  const reconcile = () => {
    const state = useKeel.getState();
    const inputs = [state.ready, state.restoreStatus, state.projects, state.generations, state.vpn];
    if (inputs.every((value, index) => value === seen[index])) return;
    seen = inputs;
    if (!state.ready || state.restoreStatus === "failed") return;
    const ready = networkReady(state.vpn);
    const present = new Set<string>();
    for (const project of state.projects) {
      for (const deck of project.decks) {
        for (const pane of Object.values(deck.panes)) {
          if (pane.editor) continue;
          present.add(pane.id);
          const generation = state.generations[pane.id] ?? 0;
          if (started.get(pane.id) === generation) {
            // A CLI typed into an already-open shell paints before the pane is
            // bound to it. That output was not read for agent status; have
            // the screen read once now the pane knows what it is running.
            const command = commandOf(pane);
            if (command !== commands.get(pane.id)) {
              commands.set(pane.id, command);
              if (command) void ptySample(pane.id, generation).catch(() => {});
            }
            continue;
          }
          if (!ready) continue;
          started.set(pane.id, generation);
          void spawn(project, pane, generation);
        }
      }
    }
    for (const paneId of started.keys()) {
      if (!present.has(paneId)) {
        started.delete(paneId);
        commands.delete(paneId);
      }
    }
  };

  const unsubscribe = useKeel.subscribe(reconcile);
  reconcile();
  return unsubscribe;
}
