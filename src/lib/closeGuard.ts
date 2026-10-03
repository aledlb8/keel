/**
 * Quit is a request, not a kill. Rust prevents the window from disappearing
 * until we confirm unsaved buffers and flush keel.json.
 */

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";

import { ask } from "@/lib/ask";

import { useKeel } from "@/state/store";
import { useWorkspace } from "@/state/workspace";

let closing = false;

function dirtyNames(): string[] {
  const state = useWorkspace.getState();
  const extra =
    "unsavedFilesAll" in state &&
    typeof (state as { unsavedFilesAll?: unknown }).unsavedFilesAll ===
      "function"
      ? (
          state as { unsavedFilesAll: () => { name: string }[] }
        ).unsavedFilesAll()
      : [];
  const open = state.editors
    .filter(
      (tab) =>
        tab.kind === "file" &&
        (state.buffers[tab.id] ?? "") !== (state.originals[tab.id] ?? ""),
    )
    .map((tab) => ({ name: tab.name }));
  return [...new Set([...open, ...extra].map((file) => file.name))];
}

export async function confirmUnsaved(action: string): Promise<boolean> {
  const names = dirtyNames();
  if (names.length === 0) return true;
  const list =
    names.length === 1
      ? names[0]
      : names.length <= 3
        ? names.join(", ")
        : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  return ask(`${action} discards unsaved changes to ${list}.`, {
    title: "Discard unsaved changes?",
    confirm: action,
    destructive: true,
  });
}

export async function handleCloseRequested(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    if (!(await confirmUnsaved("Quit"))) {
      closing = false;
      return;
    }
    await useKeel.getState().flushPersist();
    await getCurrentWindow().destroy();
  } catch {
    closing = false;
    toast.error("Couldn't finish saving and closing Keel. The window has stayed open; try again.");
  }
}

/** Listen for Rust's CloseRequested event. Returns an unlisten function. */
export function startCloseGuard(): () => void {
  let stop: (() => void) | undefined;
  let alive = true;
  void listen("app:close-requested", () => {
    void handleCloseRequested();
  }).then((unlisten) => {
    if (!alive) unlisten();
    else stop = unlisten;
  });
  const onHidden = () => {
    if (document.visibilityState === "hidden") {
      void useKeel.getState().flushPersist().catch(() => {});
    }
  };
  document.addEventListener("visibilitychange", onHidden);
  return () => {
    alive = false;
    stop?.();
    document.removeEventListener("visibilitychange", onHidden);
  };
}
