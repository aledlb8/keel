/**
 * What Rust tells the main window about panes, wired into the store.
 *
 * A pane may be drawn in the main window, in another window, or in none, and
 * none of that changes what the main window hears: the shell exited, a CLI
 * started or stopped in it, it printed, its screen settled, it set a title,
 * its shell moved folder, an agent hook fired. All of it arrives here, from
 * the pane's terminal in Rust rather than from whichever xterm is showing it.
 */

import type { AgentScreen } from "./agentActivity.ts";
import { briefFromOsc } from "./paneTitle.ts";
import {
  onPtyActivity,
  onPtyAgentEvent,
  onPtyAgentExit,
  onPtyAgentStart,
  onPtyExit,
  onPtyOsc,
  onPtyTitle,
  ptyScreenWanted,
} from "./pty.ts";
import { cwdFromOsc7, cwdFromOsc99 } from "./terminalCwd.ts";
import { useKeel } from "../state/store.ts";

function current(paneId: string, generation: number): boolean {
  return (useKeel.getState().generations[paneId] ?? 0) === generation;
}

/** Returns the teardown. Call once, in the main window. */
export function startPaneEvents(): () => void {
  /** The last screen each pane reported, for "same as before". */
  const screens = new Map<string, { generation: number; screen: AgentScreen }>();
  /** What Rust was last told about reading each pane's screen. Default: yes. */
  const wanted = new Map<string, { generation: number; wanted: boolean }>();

  // Agents that report through hooks stop needing their screen read; tell Rust
  // so it stops reading and sending it.
  const reconcileScreen = (paneId: string, generation: number) => {
    const needs = useKeel.getState().needsAgentScreen(paneId, generation);
    const told = wanted.get(paneId);
    const was = told?.generation === generation ? told.wanted : true;
    if (needs === was) return;
    wanted.set(paneId, { generation, wanted: needs });
    void ptyScreenWanted(paneId, generation, needs).catch(() => {});
  };

  const stops = [
    onPtyExit((paneId, generation) => {
      useKeel.getState().notePaneExit(paneId, generation);
    }),
    onPtyAgentExit((paneId, generation, processId) => {
      useKeel.getState().releaseAgent(paneId, generation, processId);
    }),
    onPtyAgentStart((paneId, generation, agentId, processId) => {
      useKeel.getState().noteRunningAgent(paneId, generation, agentId, processId);
    }),
    onPtyAgentEvent((paneId, generation, event) => {
      useKeel.getState().noteAgentEvent(paneId, generation, event);
      reconcileScreen(paneId, generation);
    }),
    onPtyActivity(({ id, generation, kind, screen }) => {
      if (!current(id, generation)) return;
      const keel = useKeel.getState();
      if (kind === "output") {
        keel.noteOutput(id);
        return;
      }
      const shown = screen ?? (screens.get(id)?.generation === generation ? screens.get(id)?.screen : undefined);
      if (!shown) return;
      if (screen) screens.set(id, { generation, screen });
      keel.noteScreen(id, generation, shown);
      reconcileScreen(id, generation);
    }),
    onPtyTitle((paneId, generation, title) => {
      if (!current(paneId, generation)) return;
      // briefFromOsc strips C0/C1, generic program names, and "Keel".
      const brief = briefFromOsc(title, null);
      if (brief) useKeel.getState().autoTitlePane(paneId, brief, "osc");
    }),
    // Shells announce their folder on every prompt (OSC 9;9 / OSC 7); deciding
    // what is worth keeping happens in the store. OSC 9 arrives with its
    // sub-ident on the front of the payload — `9;…` for a folder.
    onPtyOsc((paneId, generation, _ident, data) => {
      if (!current(paneId, generation)) return;
      const dir = data.startsWith("9;") ? cwdFromOsc99(data.slice(2)) : cwdFromOsc7(data);
      if (dir) useKeel.getState().notePaneCwd(paneId, dir);
    }),
  ];

  return () => {
    for (const stop of stops) void stop.then((unlisten) => unlisten());
  };
}
