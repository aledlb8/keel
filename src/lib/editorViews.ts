/**
 * Live CodeMirror views, so Find in files can jump to a line.
 *
 * The editor is created after the file loads, so a click in the search panel
 * often arrives before the view exists. A pending reveal waits for that
 * registration instead of being lost.
 */

import { EditorView } from "@codemirror/view";

/** The same file can be open in two panes; jump every live view. */
const views = new Map<string, EditorView[]>();
const pending = new Map<string, { line: number; column?: number }>();

/** A newer navigation or project switch invalidates reveals that have not mounted. */
export function clearEditorReveals(): void {
  pending.clear();
}

function applyReveal(
  view: EditorView,
  line: number,
  column: number | undefined,
): void {
  const doc = view.state.doc;
  const approx = Math.min(Math.max(line, 1), Math.max(doc.lines, 1));
  const info = doc.line(approx);
  const { offset } = clampReveal(doc.lines, info.length, line, column);
  const pos = info.from + offset;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
}

/** Clamp a 1-based line/column to a document, returning a 0-based offset in that line. */
export function clampReveal(
  docLines: number,
  lineLength: number,
  line: number,
  column?: number,
): { line: number; offset: number } {
  const clampedLine = Math.min(Math.max(line, 1), Math.max(docLines, 1));
  const offset = Math.min(Math.max((column ?? 1) - 1, 0), Math.max(lineLength, 0));
  return { line: clampedLine, offset };
}

export function registerEditorView(id: string, view: EditorView): () => void {
  const list = views.get(id) ?? [];
  list.push(view);
  views.set(id, list);
  const queued = pending.get(id);
  if (queued) {
    pending.delete(id);
    applyReveal(view, queued.line, queued.column);
    view.focus();
  }
  return () => {
    const current = views.get(id);
    if (!current) return;
    const next = current.filter((item) => item !== view);
    if (next.length) views.set(id, next);
    else views.delete(id);
  };
}

export function revealInEditor(id: string, line: number, column?: number): boolean {
  // Keep a pending jump so a pane that is still mounting (openFile then reveal)
  // lands on the same line once its view registers. If a view already exists,
  // only retain the jump briefly for other panes mounting the same file.
  pending.set(id, column === undefined ? { line } : { line, column });
  const list = views.get(id);
  if (list?.length) {
    for (const view of list) applyReveal(view, line, column);
    const focused = list.find((view) => view.hasFocus) ?? list[list.length - 1];
    focused?.focus();
  }
  const expire = pending.get(id);
  if (list?.length) {
    setTimeout(() => {
      if (pending.get(id) === expire) pending.delete(id);
    }, 500);
  }
  return Boolean(list?.length);
}
