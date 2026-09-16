/**
 * The bridge to the Rust PTYs.
 *
 * Output arrives as raw `ArrayBuffer` batches over a Tauri channel — no JSON, no
 * per-line events. Everything downstream of here deals in bytes.
 */

import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { invoke } from "./invoke.ts";

export interface SpawnOptions {
  id: string;
  generation: number;
  shell?: string | null;
  cwd?: string | null;
  /** Typed into the shell once it is up. This is how an agent gets launched. */
  command?: string | null;
  accountEnv?: string | null;
  accountId?: string | null;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}

export async function spawnPty(
  options: SpawnOptions,
  onData: (bytes: Uint8Array) => void,
): Promise<void> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (message) =>
    // Raw responses arrive as an ArrayBuffer; older webviews hand back an array.
    onData(
      message instanceof ArrayBuffer
        ? new Uint8Array(message)
        : new Uint8Array(message as unknown as number[]),
    );
  await invoke("pty_spawn", { options, onData: channel });
}

export function writePty(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function resizePty(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export function killPty(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

export function ptyAlive(id: string): Promise<boolean> {
  return invoke("pty_alive", { id });
}

/** Fires when a pane's shell finally exits. */
export function onPtyExit(
  handler: (id: string, generation: number) => void,
): Promise<() => void> {
  return listen<{ id: string; generation: number }>("pty:exit", (event) =>
    handler(event.payload.id, event.payload.generation));
}

/** Fires when the agent typed into a pane has exited and left the shell. */
export function onPtyAgentExit(
  handler: (id: string, generation: number) => void,
): Promise<() => void> {
  return listen<{ id: string; generation: number }>("pty:agent-exit", (event) =>
    handler(event.payload.id, event.payload.generation),
  );
}

/** Fires when the typed-in agent process has actually appeared. */
export function onPtyAgentStart(
  handler: (id: string, generation: number) => void,
): Promise<() => void> {
  return listen<{ id: string; generation: number }>("pty:agent-start", (event) =>
    handler(event.payload.id, event.payload.generation),
  );
}
