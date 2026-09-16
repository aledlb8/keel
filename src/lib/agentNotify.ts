/**
 * OS toasts and the chime for an agent that finished, or whose process died,
 * while you were looking at something else.
 *
 * The island already covers "an agent finished" inside the window. These
 * alerts exist for the alt-tab-away-and-forget case: never while the window
 * has focus, never for a muted pane, never during restore, never for an
 * editor or a plain shell. The policy lives in `shouldAlert` so it can be
 * tested without IPC.
 */

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { playChime } from "./chime.ts";

export type AgentAlertKind = "done" | "exited";

export interface AgentAlert {
  kind: AgentAlertKind;
  paneId: string;
  title: string;
  projectName: string;
  muted: boolean;
  windowFocused: boolean;
  restoring: boolean;
  /** editor pane or no agent */
  silentPane: boolean;
}

const DEBOUNCE_MS = 2000;
const recent = new Map<string, number>();
/** `null` until the first toast actually asks. Denied stays denied this session. */
let granted: boolean | null = null;

export function shouldAlert(alert: AgentAlert): { notify: boolean; chime: boolean } {
  const ok =
    !alert.muted &&
    !alert.silentPane &&
    !alert.restoring &&
    !alert.windowFocused;
  return { notify: ok, chime: ok };
}

export function alertCopy(
  alert: Pick<AgentAlert, "kind" | "title" | "projectName">,
): { title: string; body: string } {
  if (alert.kind === "exited") {
    return { title: `${alert.title} exited`, body: "The agent process stopped" };
  }
  const project = alert.projectName.trim();
  return {
    title: `${alert.title} finished`,
    body: project ? `Waiting in ${project}` : "",
  };
}

/** Request permission once, then send a silent OS toast. Never throws. */
export function notifyAgent(alert: AgentAlert): void {
  try {
    const { notify, chime } = shouldAlert(alert);
    if (!notify && !chime) return;
    const key = `${alert.paneId}:${alert.kind}`;
    const now = Date.now();
    const last = recent.get(key);
    if (last !== undefined && now >= last && now - last < DEBOUNCE_MS) return;
    recent.set(key, now);
    if (chime) playChime();
    if (notify) void sendSilent(alert);
  } catch {
    /* Never throw into the tracker. */
  }
}

async function sendSilent(alert: AgentAlert): Promise<void> {
  try {
    const { title, body } = alertCopy(alert);
    if (granted == null) {
      granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
    }
    if (!granted) return;
    // No `sound`: we play our own chime. Windows + an OS sound would double.
    sendNotification(body ? { title, body } : { title });
  } catch {
    /* Dev toasts can fail; a missing plugin must not interrupt the session. */
  }
}
