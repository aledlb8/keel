/**
 * A CodeMirror surface for one open file. Created once per tab id so typing
 * does not remount the editor.
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
import { useWorkspace } from "@/state/workspace";

export function CodeEditor({ id, rel }: { id: string; rel: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const state = useWorkspace.getState();
    const snapshot = state.snapshots[id];
    const readOnly = Boolean(snapshot?.binary);
    const language = languageFor(rel);
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
              useWorkspace
                .getState()
                .setBuffer(id, update.state.doc.toString());
            }
          }),
          ...(language ? [language] : []),
        ],
      }),
    });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [id, rel]);

  return <div ref={hostRef} className="h-full min-h-0" />;
}
