/** Open files and diffs, named the same way in the layout and in the editor's cache. */

import type { EditorRef } from "./types.ts";

export function fileTabId(rel: string): string {
  return `file:${rel}`;
}

export function diffTabId(rel: string, staged: boolean): string {
  return `diff:${staged ? "staged" : "work"}:${rel}`;
}

export function editorRefId(ref: EditorRef): string {
  return ref.kind === "diff" ? diffTabId(ref.rel, ref.staged) : fileTabId(ref.rel);
}

/** What a tab is called: the file's own name. */
export function editorRefName(ref: EditorRef): string {
  const index = ref.rel.lastIndexOf("/");
  return index < 0 ? ref.rel : ref.rel.slice(index + 1);
}
