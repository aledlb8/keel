export type AgentEventKind = "connected" | "unavailable" | "session" | "identity" | "working" | "progress" |
  "waiting" | "completed" | "cancelled" | "failed" | "ended" | "idle";

/** The backend channel is bound to one PTY generation, never a folder. */
export interface AgentEvent {
  agentId: string;
  sessionId: string;
  kind: AgentEventKind;
  sequence: number;
  /** Verified agent process, not the short-lived hook helper. */
  processId?: string;
  /** Provider turn identity when available (Codex). */
  turnId?: string;
}

export function hasAgentHooks(agentId: string): boolean {
  return ["claude", "codex", "grok", "opencode"].includes(agentId);
}
