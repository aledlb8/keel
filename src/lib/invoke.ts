/**
 * Thin invoke wrapper: same Tauri IPC, plus a hook when the host looks dead.
 *
 * No new backend contracts — we only inspect rejected invoke errors and notify
 * listeners when the failure pattern matches a dead/unreachable host bridge.
 */

import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";

type HostLostListener = () => void;

const hostLostListeners = new Set<HostLostListener>();

/** Subscribe to "Keel host stopped responding" style IPC failures. */
export function onHostLost(listener: HostLostListener): () => void {
  hostLostListeners.add(listener);
  return () => {
    hostLostListeners.delete(listener);
  };
}

function notifyHostLost() {
  for (const listener of hostLostListeners) {
    try {
      listener();
    } catch {
      /* A broken listener must not break IPC. */
    }
  }
}

/** Heuristic: reject looks like the webview bridge is gone. */
export function looksLikeHostDeath(error: unknown): boolean {
  const raw =
    error == null
      ? ""
      : typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : typeof error === "object" &&
              error !== null &&
              "message" in error &&
              typeof (error as { message: unknown }).message === "string"
            ? (error as { message: string }).message
            : String(error);

  const msg = raw.trim().toLowerCase();
  if (!msg || msg === "undefined" || msg === "[object object]") return true;

  // Git/HTTP "connection refused" and friends are not a dead webview bridge.
  return (
    /webview/.test(msg) ||
    /\bipc\b/.test(msg) ||
    /tauri[\s._-]?api/.test(msg) ||
    /failed to communicate with the main process/.test(msg) ||
    /host (?:gone|unavailable|stopped|not responding)/.test(msg) ||
    /backend (?:gone|unavailable|stopped)/.test(msg)
  );
}

export function reportInvokeError(error: unknown) {
  if (looksLikeHostDeath(error)) notifyHostLost();
}

/** Drop-in for tauri invoke — rethrows after host-death notify. */
export async function invoke<T>(
  cmd: string,
  args?: InvokeArgs,
): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (error) {
    reportInvokeError(error);
    throw error;
  }
}