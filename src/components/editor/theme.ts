/** CodeMirror theme locked to Keel's terminal palette. */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const highlight = HighlightStyle.define([
  { tag: t.comment, color: "#707070" },
  { tag: t.lineComment, color: "#707070" },
  { tag: t.blockComment, color: "#707070" },
  { tag: t.docComment, color: "#707070" },
  { tag: t.keyword, color: "#b48cf2" },
  { tag: t.controlKeyword, color: "#b48cf2" },
  { tag: t.moduleKeyword, color: "#b48cf2" },
  { tag: t.operatorKeyword, color: "#b48cf2" },
  { tag: t.definitionKeyword, color: "#b48cf2" },
  { tag: t.string, color: "#4cc38a" },
  { tag: t.special(t.string), color: "#4cc38a" },
  { tag: t.number, color: "#e9a23b" },
  { tag: t.bool, color: "#e9a23b" },
  { tag: t.null, color: "#e9a23b" },
  { tag: t.function(t.variableName), color: "#6c9bf5" },
  { tag: t.function(t.propertyName), color: "#6c9bf5" },
  { tag: t.definition(t.variableName), color: "#6c9bf5" },
  { tag: t.typeName, color: "#3fc1b0" },
  { tag: t.className, color: "#3fc1b0" },
  { tag: t.namespace, color: "#3fc1b0" },
  { tag: t.propertyName, color: "#c7c7c7" },
  { tag: t.variableName, color: "#e6e6e6" },
  { tag: t.punctuation, color: "#a1a1a1" },
  { tag: t.operator, color: "#a1a1a1" },
  { tag: t.tagName, color: "#6c9bf5" },
  { tag: t.attributeName, color: "#e9a23b" },
  { tag: t.heading, color: "#6c9bf5", fontWeight: "600" },
  { tag: t.link, color: "#6c9bf5" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.invalid, color: "#ec5d5e" },
]);

const chrome = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "transparent",
      color: "#e6e6e6",
    },
    ".cm-scroller": {
      fontFamily: "var(--keel-font-mono)",
      fontSize: "13px",
      lineHeight: "1.55",
    },
    ".cm-content": {
      caretColor: "#ededed",
      padding: "8px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#ededed",
    },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "rgba(255, 255, 255, 0.16)",
      },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "#707070",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 16px 0 14px",
      minWidth: "48px",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255, 255, 255, 0.03)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "#a1a1a1",
    },
    // The search panel, restyled from CodeMirror's light-grey form controls.
    ".cm-panels": {
      backgroundColor: "#161616",
      color: "#ededed",
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: "1px solid rgba(255, 255, 255, 0.07)",
    },
    ".cm-panel.cm-search": {
      padding: "8px 10px",
      fontFamily: "var(--font-sans)",
      fontSize: "12px",
    },
    ".cm-panel.cm-search label": {
      color: "#a1a1a1",
      fontSize: "12px",
    },
    ".cm-textfield": {
      backgroundColor: "rgba(255, 255, 255, 0.04)",
      border: "1px solid rgba(255, 255, 255, 0.12)",
      borderRadius: "6px",
      color: "#ededed",
      fontSize: "12px",
      padding: "3px 7px",
      outline: "none",
    },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: "rgba(255, 255, 255, 0.075)",
      border: "none",
      borderRadius: "6px",
      color: "#ededed",
      fontSize: "12px",
      padding: "4px 9px",
    },
    ".cm-panel.cm-search [name=close]": {
      color: "#a1a1a1",
      fontSize: "16px",
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(233, 162, 59, 0.28)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(233, 162, 59, 0.5)",
    },
    ".cm-foldPlaceholder": {
      background: "transparent",
      border: "none",
      color: "#707070",
    },
  },
  { dark: true },
);

export const keelEditorTheme: Extension = [
  chrome,
  syntaxHighlighting(highlight),
];
