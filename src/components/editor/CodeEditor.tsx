/**
 * A CodeMirror surface for one open file. Created once per tab id so typing
 * does not remount the editor.
 *
 * The same file can be open in two panes at once, so each surface follows the
 * shared buffer: what you type in one appears in the other, and neither can
 * save a stale copy over the other's edits.
 */

import { useEffect, useRef } from "react";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";

import { languageFor } from "@/components/editor/language";
import { keelEditorTheme } from "@/components/editor/theme";
import { registerEditorView } from "@/lib/editorViews";
import { useWorkspace } from "@/state/workspace";

export function CodeEditor({
  id,
  rel,
  focused,
}: {
  id: string;
  rel: string;
  /** Its pane has focus: the caret goes here. */
  focused: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const state = useWorkspace.getState();
    const snapshot = state.snapshots[id];
    const readOnly = Boolean(snapshot?.binary);
    const language = languageFor(rel);
    /** The buffer as this surface last wrote or received it. */
    let known = state.buffers[id] ?? "";
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: state.buffers[id] ?? "",
        extensions: [
          keelEditorTheme,
          history(),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          bracketMatching(),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                void useWorkspace.getState().saveTab(id);
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.editable.of(!readOnly),
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              known = update.state.doc.toString();
              useWorkspace.getState().setBuffer(id, known);
            }
          }),
          ...(language ? [language] : []),
        ],
      }),
    });
    viewRef.current = view;
    const unregister = registerEditorView(id, view);

    // Another pane showing this file typed into it.
    const unsubscribe = useWorkspace.subscribe((next) => {
      const text = next.buffers[id];
      if (text === undefined || text === known) return;
      known = text;
      if (text === view.state.doc.toString()) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    });

    return () => {
      unregister();
      unsubscribe();
      view.destroy();
      viewRef.current = null;
    };
  }, [id, rel]);

  useEffect(() => {
    if (focused) viewRef.current?.focus();
  }, [focused, id, rel]);

  return <div ref={hostRef} className="h-full min-h-0" />;
}
