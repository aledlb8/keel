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
import { sanitizeTitle, TITLE_MAX } from "./paneTitle.ts";

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
const MAX_RECENT_ALERTS = 200;
const recent = new Map<string, number>();
/** `null` until the first toast actually asks. Denied stays denied this session. */
let granted: boolean | null = null;

function alertKey(paneId: string, kind: AgentAlertKind): string {
  return `${paneId}:${kind}`;
}

/** Drop debounce memory for a pane that was closed. */
export function forgetPaneAlerts(paneId: string): void {
  recent.delete(alertKey(paneId, "done"));
  recent.delete(alertKey(paneId, "exited"));
}

/** Drop stale debounce entries, then the oldest if the map is still over the cap. */
export function pruneAlertMap(
  map: Map<string, number>,
  now: number,
  max = MAX_RECENT_ALERTS,
): void {
  for (const [key, at] of map) {
    if (now - at >= DEBOUNCE_MS) map.delete(key);
  }
  if (map.size <= max) return;
  const extra = map.size - max;
  const oldest = [...map].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  for (const [key] of oldest.slice(0, extra)) map.delete(key);
}

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
  const title = sanitizeTitle(alert.title).slice(0, TITLE_MAX) || "Agent";
  if (alert.kind === "exited") {
    return { title: `${title} exited`, body: "The agent process stopped" };
  }
  const project = sanitizeTitle(alert.projectName).slice(0, TITLE_MAX);
  return {
    title: `${title} finished`,
    body: project ? `Waiting in ${project}` : "",
  };
}

/** Request permission once, then send a silent OS toast. Never throws. */
export function notifyAgent(alert: AgentAlert): void {
  try {
    const { notify, chime } = shouldAlert(alert);
    if (!notify && !chime) return;
    const key = alertKey(alert.paneId, alert.kind);
    const now = Date.now();
    pruneAlertMap(recent, now);
    const last = recent.get(key);
    if (last !== undefined && now >= last && now - last < DEBOUNCE_MS) return;
    recent.set(key, now);
    pruneAlertMap(recent, now);
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
