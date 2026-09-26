/**
 * The line typed into a pane's shell: the agent's command, plus whatever that
 * CLI needs to reopen a specific conversation.
 *
 * A newly opened agent is always a new chat: the bare command, with no
 * `--session-id`, `--resume`, `--continue`, or `--last`. The agent creates the
 * conversation; Keel receives its identity through provider hooks.
 *
 * `--resume` is typed only when this pane already has a captured conversation
 * (`sessionReady`). That covers power-up restore and an explicit Restart of
 * the same pane. Never `--continue` / `--last`: those reopen whichever chat
 * ran last in the folder, so every pane of the same agent would share it.
 */

import type { SessionSpec } from "./types";

export interface SessionState {
  sessionId: string | null;
  sessionReady: boolean;
}

/** A pane that does not yet own an agent conversation. */
export function unboundSession(): SessionState {
  return { sessionId: null, sessionReady: false };
}

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

export function applySession(
  command: string,
  session: SessionSpec | null | undefined,
  state: SessionState,
): string {
  const base = command.trim();
  if (!session || !base) return base;
  // Fresh panes launch the bare command. `session.start` (`--session-id`) is
  // never applied here: the agent must create its own conversation.
  if (!state.sessionReady) return base;

  const extra = fillTemplate(session.resume, state.sessionId);
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
    if (!id || !isSessionId(id)) return null;
    return trimmed.replace(/\{id\}/g, `"${id}"`);
  }
  return trimmed;
}
