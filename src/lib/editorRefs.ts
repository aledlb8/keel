/** Open files and diffs, named the same way in the layout and in the editor's cache. */

import type { EditorRef } from "./types.ts";

export function fileTabId(rel: string): string {
  return `file:${rel}`;
}

export function diffTabId(rel: string, staged: boolean, rev?: string | null): string {
  if (rev) return `diff:rev:${rev}:${rel}`;
  return `diff:${staged ? "staged" : "work"}:${rel}`;
}

export function editorRefId(ref: EditorRef): string {
  return ref.kind === "diff"
    ? diffTabId(ref.rel, ref.staged, ref.rev)
    : fileTabId(ref.rel);
}

/** A commit a diff can name: its full or abbreviated hash. */
export function isRev(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{4,64}$/i.test(value);
}

/** What a tab is called: the file's own name. */
export function editorRefName(ref: EditorRef): string {
  const index = ref.rel.lastIndexOf("/");
  return index < 0 ? ref.rel : ref.rel.slice(index + 1);
}
