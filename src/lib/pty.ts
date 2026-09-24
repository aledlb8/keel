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
  shell?: string | null | undefined;
  cwd?: string | null | undefined;
  /** Typed into the shell once it is up. This is how an agent gets launched. */
  command?: string | null | undefined;
  /** Catalogue id of `command`, when Keel is the one typing it. */
  agentId?: string | null | undefined;
  accountEnv?: string | null | undefined;
  accountId?: string | null | undefined;
  env?: Record<string, string> | undefined;
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

/** Matches the Rust writer chunk so a huge paste yields instead of one IPC stall. */
const WRITE_CHUNK = 64 * 1024;

export async function writePty(id: string, data: string): Promise<void> {
  if (!data) return;
  for (let offset = 0; offset < data.length; offset += WRITE_CHUNK) {
    await invoke("pty_write", { id, data: data.slice(offset, offset + WRITE_CHUNK) });
    if (offset + WRITE_CHUNK < data.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
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

/** Fires when a catalogue CLI has appeared in this shell. */
export function onPtyAgentStart(
  handler: (
    id: string,
    generation: number,
    agentId: string,
    startedMs: number,
  ) => void,
): Promise<() => void> {
  return listen<{
    id: string;
    generation: number;
    agentId: string;
    startedMs: number;
  }>("pty:agent-start", (event) =>
    handler(
      event.payload.id,
      event.payload.generation,
      event.payload.agentId,
      event.payload.startedMs,
    ),
  );
}
