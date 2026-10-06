/**
 * IPC for the main agent (see `src-tauri/src/assistant.rs`). The bot token goes
 * in and never comes back out: the window only learns whether one is set.
 */

import { listen } from "@tauri-apps/api/event";

import { invoke } from "./invoke.ts";

export type AssistantPhase = "off" | "connecting" | "online" | "error";
export type AssistantForward = "never" | "background" | "always";

export interface AssistantSnapshot {
  tokenSet: boolean;
  /** The bot's @username, without the @. */
  bot: string | null;
  phase: AssistantPhase;
  error: string | null;
  /** Name of the paired Telegram account. */
  owner: string | null;
  pairingCode: string | null;
  pairingLink: string | null;
  agentId: string | null;
  accountId: string | null;
  forward: AssistantForward;
  enabled: boolean;
  busy: boolean;
  /** What the agent is doing right now, as a short label. */
  activity: string | null;
  queued: number;
  hasSession: boolean;
  toolsReady: boolean;
  /** How voice messages are transcribed, or `null` when they can't be. */
  voice: string | null;
  /** Languages voice messages may be in, as Whisper codes. Empty means any. */
  languages: string[];
}

export type AssistantLogKind = "in" | "out" | "tool" | "event" | "error";

export interface AssistantLogEntry {
  id: number;
  /** Milliseconds since the epoch. */
  at: number;
  kind: AssistantLogKind;
  text: string;
}

export interface AssistantToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AssistantConfigure {
  agentId?: string | null;
  accountId?: string | null;
  forward?: AssistantForward;
  enabled?: boolean;
  languages?: string[];
}

/**
 * Whose work a pane is doing: the main agent's (`started`), the user's with a
 * request the main agent passed on (`handed`), or only the user's.
 */
export type AssistantPaneWhose = "started" | "handed" | "user";

export interface AssistantPaneEvent {
  kind: "done" | "waiting" | "exited";
  paneId: string;
  title: string;
  agent: string;
  project: string;
  whose: AssistantPaneWhose;
  tail: string;
  windowFocused: boolean;
}

/** Catalogue ids that can be the main agent. Mirrors `assistant_agents::SUPPORTED`. */
export const MAIN_AGENTS = ["claude", "codex", "opencode", "pi", "grok"] as const;

export const assistantIpc = {
  snapshot: () => invoke<AssistantSnapshot>("assistant_snapshot"),
  log: () => invoke<AssistantLogEntry[]>("assistant_log"),
  setToken: (token: string) => invoke<AssistantSnapshot>("assistant_set_token", { token }),
  pair: () => invoke<AssistantSnapshot>("assistant_pair"),
  unpair: () => invoke<AssistantSnapshot>("assistant_unpair"),
  configure: (change: AssistantConfigure) =>
    invoke<AssistantSnapshot>("assistant_configure", { change }),
  newConversation: () => invoke<AssistantSnapshot>("assistant_new_conversation"),
  checkVoice: () => invoke<AssistantSnapshot>("assistant_check_voice"),
  stop: () => invoke<boolean>("assistant_stop"),
  send: (text: string) => invoke<void>("assistant_send", { text }),
  toolResult: (callId: string, ok: boolean, text: string) =>
    invoke<void>("assistant_tool_result", { callId, ok, text }),
  paneEvent: (event: AssistantPaneEvent) => invoke<void>("assistant_pane_event", { event }),
};

export function onAssistantSnapshot(handler: (snapshot: AssistantSnapshot) => void) {
  return listen<AssistantSnapshot>("assistant:snapshot", (event) => handler(event.payload));
}

export function onAssistantLog(handler: (entry: AssistantLogEntry) => void) {
  return listen<AssistantLogEntry>("assistant:log", (event) => handler(event.payload));
}

export function onAssistantTool(handler: (call: AssistantToolCall) => void) {
  return listen<AssistantToolCall>("assistant:tool", (event) => handler(event.payload));
}
