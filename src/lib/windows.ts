/**
 * Keel's windows, from the frontend: open and place them, and hear what they do.
 *
 * Which deck a screen shows is the store's business (`screens` in
 * `src/state/store.ts`). This only talks to Rust about the windows themselves.
 */

import { emitTo, listen } from "@tauri-apps/api/event";

import { invoke } from "./invoke.ts";
import type { Display, WindowBounds } from "./types.ts";

/** Where to put a window: exactly here, or filling a monitor's work area. */
export interface Placement {
  bounds?: WindowBounds | undefined;
  monitor?: string | null | undefined;
}

export function displays(): Promise<Display[]> {
  return invoke("displays");
}

export function openScreenWindow(id: string, placement: Placement = {}): Promise<void> {
  return invoke("screen_open", { id, placement });
}

export function closeScreenWindow(id: string): Promise<void> {
  return invoke("screen_close", { id });
}

export function placeWindow(label: string, placement: Placement): Promise<void> {
  return invoke("window_place", { label, placement });
}

export function focusWindow(label: string): Promise<void> {
  return invoke("window_focus", { label });
}

/** Every Keel window's current place, by label. */
export async function windowBounds(): Promise<Map<string, WindowBounds>> {
  const rows = await invoke<[string, WindowBounds][]>("window_bounds");
  return new Map(rows);
}

/** A Keel window moved or was resized. Main window only. */
export function onWindowBounds(
  handler: (label: string, bounds: WindowBounds) => void,
): Promise<() => void> {
  return listen<{ label: string; bounds: WindowBounds }>("window:bounds", (event) =>
    handler(event.payload.label, event.payload.bounds));
}

/** A Keel window gained or lost the keyboard. Main window only. */
export function onWindowFocus(
  handler: (label: string, focused: boolean) => void,
): Promise<() => void> {
  return listen<{ label: string; focused: boolean }>("window:focus", (event) =>
    handler(event.payload.label, event.payload.focused));
}

/** A screen window is gone, however it was closed. Main window only. */
export function onScreenClosed(handler: (label: string) => void): Promise<() => void> {
  return listen<string>("screen:closed", (event) => handler(event.payload));
}

/** Have the window drawing a pane put the keyboard in its terminal. */
export function focusPaneIn(label: string, paneId: string): Promise<void> {
  return emitTo(label, "keel:focus-pane", paneId);
}

/** The main window asked this window to focus one of its terminals. */
export function onFocusPaneRequest(handler: (paneId: string) => void): Promise<() => void> {
  return listen<string>("keel:focus-pane", (event) => handler(event.payload));
}
