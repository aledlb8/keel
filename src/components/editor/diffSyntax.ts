/**
 * Syntax colour for a diff, from the same parsers and palette as the editor.
 *
 * Each side of a hunk — the old lines and the new — is parsed as one piece of
 * text, so a string or a comment that spans lines keeps its colour across
 * them. A hunk starts mid-file, so a parse can open inside something it
 * cannot see the start of; that is the price of not reading the whole file,
 * and it only ever miscolours, never misplaces.
 */

import type { CSSProperties } from "react";
import { Language, LanguageSupport } from "@codemirror/language";
import { highlightTree, tagHighlighter } from "@lezer/highlight";

import type { StyledSpan } from "@/lib/diffView";
import type { GitHunk } from "@/lib/workspace";

import { languageFor } from "./language";
import { SYNTAX_STYLES } from "./theme";

/** Past this much text a hunk is shown plain; the parse would stall the view. */
const MAX_TEXT = 300_000;

const highlighter = tagHighlighter(
  SYNTAX_STYLES.map((spec, index) => ({ tag: spec.tag, class: String(index) })),
);

const styles: CSSProperties[] = SYNTAX_STYLES.map((spec) => {
  const style: CSSProperties = {};
  if ("color" in spec && spec.color) style.color = spec.color;
  if ("fontWeight" in spec && spec.fontWeight) style.fontWeight = spec.fontWeight;
  if ("fontStyle" in spec && spec.fontStyle) style.fontStyle = spec.fontStyle;
  return style;
});

export function syntaxStyle(index: number | null): CSSProperties | undefined {
  return index === null ? undefined : styles[index];
}

function languageOf(rel: string): Language | null {
  const extension = languageFor(rel);
  if (extension instanceof LanguageSupport) return extension.language;
  if (extension instanceof Language) return extension;
  return null;
}

/** Spans for each line of `lines`, parsed together as one text. */
function highlightLines(language: Language, lines: string[]): StyledSpan[][] {
  const out: StyledSpan[][] = lines.map(() => []);
  const text = lines.join("\n");
  if (text.length > MAX_TEXT) return out;
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const tree = language.parser.parse(text);
  let row = 0;
  highlightTree(tree, highlighter, (from, to, classes) => {
    const style = Number(classes.split(" ")[0]);
    if (!Number.isFinite(style)) return;
    // Spans arrive in order, so the line they start on only moves forward.
    while (row + 1 < starts.length && starts[row + 1]! <= from) row++;
    for (let at = row; at < lines.length && starts[at]! < to; at++) {
      const start = Math.max(from, starts[at]!) - starts[at]!;
      const end = Math.min(to, starts[at]! + lines[at]!.length) - starts[at]!;
      if (end > start) out[at]!.push({ from: start, to: end, style });
    }
  });
  return out;
}

/**
 * Syntax spans for every line of every hunk, keyed `hunk:line`, or null when
 * the file's language is not one the editor knows.
 */
export function highlightHunks(rel: string, hunks: readonly GitHunk[]): Map<string, StyledSpan[]> | null {
  const language = languageOf(rel);
  if (!language) return null;
  const spans = new Map<string, StyledSpan[]>();
  hunks.forEach((hunk, h) => {
    for (const side of ["old", "new"] as const) {
      const indices: number[] = [];
      hunk.lines.forEach((line, l) => {
        const keep =
          line.kind === "ctx" || (side === "old" ? line.kind === "del" : line.kind === "add");
        if (keep) indices.push(l);
      });
      if (indices.length === 0) continue;
      const highlighted = highlightLines(
        language,
        indices.map((l) => hunk.lines[l]!.text),
      );
      indices.forEach((l, k) => {
        const key = `${h}:${l}`;
        // Unchanged lines appear on both sides; the new side's colour wins.
        if (side === "old" && hunk.lines[l]!.kind === "ctx") return;
        spans.set(key, highlighted[k]!);
      });
    }
  });
  return spans;
}
