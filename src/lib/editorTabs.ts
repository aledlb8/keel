/**
 * Showing one of an editor pane's open files.
 *
 * Which tab is on screen belongs to the layout (`useKeel`, saved with the
 * deck), while what the editor is doing with it — the buffer, where it should
 * scroll to — belongs to `useWorkspace`. The two stores stay unaware of each
 * other on purpose, so both have to be told, and the pairing lives here rather
 * than in each of the three places that switch tabs.
 */

import { editorRefId } from "@/lib/editorRefs";
import type { Pane } from "@/lib/types";
import { useKeel } from "@/state/store";
import { useWorkspace } from "@/state/workspace";

export function showEditorTab(projectId: string, paneId: string, tabId: string) {
  useKeel.getState().selectEditorTab(projectId, paneId, tabId);
  useWorkspace.getState().setActiveEditor(tabId);
}

/**
 * The next file along in a pane, wrapping at either end — the way cycling the
 * panes and the decks already wraps. One open file, or none, is a no-op.
 */
export function cycleEditorTab(projectId: string, pane: Pane, step: 1 | -1) {
  const editor = pane.editor;
  if (!editor || editor.tabs.length < 2) return;
  const at = editor.tabs.findIndex((tab) => editorRefId(tab) === editor.active);
  const from = at < 0 ? 0 : at;
  const next = editor.tabs[(from + step + editor.tabs.length) % editor.tabs.length];
  if (next) showEditorTab(projectId, pane.id, editorRefId(next));
}
