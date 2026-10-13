/**
 * The bridge to the Rust PTYs.
 *
 * Output arrives as raw `ArrayBuffer` batches over a Tauri channel — no JSON, no
 * per-line events. Everything downstream of here deals in bytes.
 *
 * Rust keeps each pane's terminal state itself. A window that starts drawing a
 * pane attaches to it and is sent a replay first; the window that drew it before
 * is sent nothing more. What the main window needs to know about a pane — it
 * printed, what its screen says, the folder and title it reported, agent hooks —
 * arrives as events, whichever window is drawing it.
 */

import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { invoke } from "./invoke.ts";
import type { AgentEvent } from "./agentEvents.ts";
import type { AgentScreen } from "./agentActivity.ts";

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

/** The size a replay was drawn at, and whether the shell is still running. */
export interface Attached {
  cols: number;
  rows: number;
  alive: boolean;
}

/** Where a pane's bytes are going. `id` is what `detachPty` needs. */
export interface OutputChannel {
  id: number;
}

function outputChannel(onData: (bytes: Uint8Array) => void): Channel<ArrayBuffer> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (message) =>
    // Raw responses arrive as an ArrayBuffer; older webviews hand back an array.
    onData(
      message instanceof ArrayBuffer
        ? new Uint8Array(message)
        : new Uint8Array(message as unknown as number[]),
    );
  return channel;
}

/** Start a pane's process. No window draws it until one attaches. */
export function spawnPty(options: SpawnOptions): Promise<void> {
  return invoke("pty_spawn", { options });
}

/** A pane's process is up; a window waiting to draw it can attach. */
export function onPtySpawned(
  handler: (id: string, generation: number) => void,
): Promise<() => void> {
  return listen<{ id: string; generation: number }>("pty:spawned", (event) =>
    handler(event.payload.id, event.payload.generation));
}

export interface Attachment {
  attached: Attached;
  channel: OutputChannel;
  /**
   * Start delivering: the replay, anything that arrived since, then live
   * output. Call once the terminal is the size `attached` says.
   */
  release: () => void;
}

/**
 * Draw an existing pane here. Nothing reaches `onData` until `release`, so the
 * caller can size its terminal to the replay first — the replay and the
 * attach reply travel separately and either can arrive first. `null` when this
 * generation of the pane has no terminal.
 */
export async function attachPty(
  id: string,
  generation: number,
  onData: (bytes: Uint8Array) => void,
): Promise<Attachment | null> {
  let released = false;
  const held: Uint8Array[] = [];
  const channel = outputChannel((bytes) => {
    if (released) onData(bytes);
    else held.push(bytes);
  });
  const attached = await invoke<Attached | null>("pty_attach", {
    id,
    generation,
    onData: channel,
  });
  if (!attached) return null;
  return {
    attached,
    channel: { id: channel.id },
    release: () => {
      if (released) return;
      released = true;
      for (const bytes of held.splice(0)) onData(bytes);
    },
  };
}

export function detachPty(id: string, channel: OutputChannel): Promise<void> {
  return invoke("pty_detach", { id, channel: channel.id });
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

/** The bottom of a pane as plain text, from Rust's copy. `null` with no terminal. */
export function ptyText(id: string, lines: number): Promise<string | null> {
  return invoke("pty_text", { id, lines });
}

/** Paste the way xterm would, into a pane this window is not drawing. */
export function ptyPaste(id: string, text: string): Promise<string | null> {
  return invoke("pty_paste", { id, text });
}

/** Read a pane's screen now; it arrives as a `screen` activity. */
export function ptySample(id: string, generation: number): Promise<void> {
  return invoke("pty_sample", { id, generation });
}

export function ptyScreenWanted(
  id: string,
  generation: number,
  wanted: boolean,
): Promise<void> {
  return invoke("pty_screen_wanted", { id, generation, wanted });
}

/** Milliseconds since the pane last printed; `null` with no terminal. */
export function ptyQuiet(id: string): Promise<number | null> {
  return invoke("pty_quiet", { id });
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
  handler: (id: string, generation: number, processId?: string) => void,
): Promise<() => void> {
  return listen<{ id: string; generation: number; processId: string | null }>("pty:agent-exit", (event) =>
    handler(event.payload.id, event.payload.generation, event.payload.processId ?? undefined),
  );
}

/** Fires when a catalogue CLI has appeared in this shell. */
export function onPtyAgentStart(
  handler: (
    id: string,
    generation: number,
    agentId: string,
    processId?: string,
  ) => void,
): Promise<() => void> {
  return listen<{
    id: string;
    generation: number;
    agentId: string;
    processId: string | null;
  }>("pty:agent-start", (event) =>
    handler(
      event.payload.id,
      event.payload.generation,
      event.payload.agentId,
      event.payload.processId ?? undefined,
    ),
  );
}

export interface PtyActivity {
  id: string;
  generation: number;
  kind: "output" | "screen";
  /** For `screen`: what it shows, or absent when it shows what it did last. */
  screen?: AgentScreen;
}

/** A pane printed, or its screen settled after printing. Main window only. */
export function onPtyActivity(
  handler: (activity: PtyActivity) => void,
): Promise<() => void> {
  return listen<PtyActivity>("pty:activity", (event) => handler(event.payload));
}

/** A pane set its title (OSC 0 / 2). Main window only. */
export function onPtyTitle(
  handler: (id: string, generation: number, title: string) => void,
): Promise<() => void> {
  return listen<{ id: string; generation: number; title: string }>("pty:title", (event) =>
    handler(event.payload.id, event.payload.generation, event.payload.title));
}

/** A pane's shell reported its folder (OSC 7, or OSC 9 with its sub-ident). */
export function onPtyOsc(
  handler: (id: string, generation: number, ident: number, data: string) => void,
): Promise<() => void> {
  return listen<{ id: string; generation: number; ident: number; data: string }>(
    "pty:osc",
    (event) =>
      handler(event.payload.id, event.payload.generation, event.payload.ident, event.payload.data),
  );
}

/** An agent hook fired in a pane. Main window only. */
export function onPtyAgentEvent(
  handler: (id: string, generation: number, event: AgentEvent) => void,
): Promise<() => void> {
  return listen<{ id: string; generation: number; event: AgentEvent }>(
    "pty:agent-event",
    (event) => handler(event.payload.id, event.payload.generation, event.payload.event),
  );
}
