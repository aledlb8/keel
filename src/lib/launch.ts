/**
 * The line typed into a pane's shell: the agent's command, plus whatever that
 * CLI needs to reopen a specific conversation.
 *
 * First spawn is a new session (or the agent's start flag with a UUID we
 * picked). Once that process has come up, later spawns use the resume flag so
 * closing Keel and opening it again lands in the same chat.
 */

import type { SessionSpec } from "./types";

export interface SessionState {
  sessionId: string | null;
  sessionReady: boolean;
}

/** True when this CLI lets us pick the session UUID on first launch. */
export function sessionNeedsId(session: SessionSpec | null | undefined): boolean {
  return (session?.start ?? "").includes("{id}");
}

export function applySession(
  command: string,
  session: SessionSpec | null | undefined,
  state: SessionState,
): string {
  const base = command.trim();
  if (!session || !base) return base;

  const template = state.sessionReady
    ? session.resume
    : (session.start ?? "");
  // Never fall back to `--continue` / `--last`: those reopen whichever chat
  // ran last in this folder, so every pane of the same agent would share it.
  const extra = fillTemplate(template, state.sessionId);
  if (!extra) return base;

  if (session.kind === "subcommand") {
    const match = /^(\S+)(?:\s+(.*))?$/.exec(base);
    if (!match) return base;
    const bin = match[1];
    const rest = match[2];
    return rest ? `${bin} ${extra} ${rest}` : `${bin} ${extra}`;
  }
  return `${base} ${extra}`;
}

function fillTemplate(template: string, id: string | null): string | null {
  const trimmed = template.trim();
  if (!trimmed) return null;
  if (trimmed.includes("{id}")) {
    if (!id) return null;
    return trimmed.replace(/\{id\}/g, id);
  }
  return trimmed;
}
