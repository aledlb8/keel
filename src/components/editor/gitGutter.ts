/**
 * The change gutter: a thin bar beside every line that differs from the last
 * commit — green where lines were added, amber where they were changed, and a
 * red notch where lines were deleted — in the colours the file tree uses for
 * the same states.
 *
 * It diffs the live buffer, not the file on disk, so a bar appears as you type
 * and goes away when you type the line back the way it was. Between refreshes
 * the bars ride along with the edit so nothing jumps.
 */

import {
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  type ViewUpdate,
} from "@codemirror/view";

import { lineChanges, splitLines, type LineChangeKind } from "@/lib/lineDiff";

/** Diff at most this often while typing; the bars ride along in between. */
const REFRESH_MS = 90;

type Edge = "top" | "bottom";

class ChangeMarker extends GutterMarker {
  constructor(
    readonly kind: LineChangeKind,
    readonly title: string,
    /** Rounds the bar's end on the first/last line of a run, or which edge a deletion sits on. */
    readonly first: boolean,
    readonly last: boolean,
    readonly edge: Edge | null = null,
  ) {
    super();
  }

  eq(other: ChangeMarker) {
    return (
      this.kind === other.kind &&
      this.title === other.title &&
      this.first === other.first &&
      this.last === other.last &&
      this.edge === other.edge
    );
  }

  toDOM() {
    const mark = document.createElement("div");
    mark.className = `cm-gitMark cm-gitMark-${this.kind}`;
    if (this.first) mark.classList.add("cm-gitMark-first");
    if (this.last) mark.classList.add("cm-gitMark-last");
    if (this.edge) mark.classList.add(`cm-gitMark-${this.edge}`);
    mark.title = this.title;
    return mark;
  }
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The document's lines, counted the same way as the committed text. */
function docLines(doc: Text): string[] {
  const lines: string[] = [];
  for (const line of doc.iterLines()) lines.push(line);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function buildMarks(base: readonly string[], doc: Text): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const change of lineChanges(base, docLines(doc))) {
    if (change.kind === "deleted") {
      // The notch sits on the seam where the lines were: under the line before
      // it, or over the first line when the top of the file went.
      const atTop = change.from === 0;
      const line = doc.line(atTop ? 1 : Math.min(change.from, doc.lines));
      const title = `${plural(change.removed, "line")} deleted`;
      builder.add(
        line.from,
        line.from,
        new ChangeMarker("deleted", title, false, false, atTop ? "top" : "bottom"),
      );
      continue;
    }
    const count = change.to - change.from;
    const title =
      change.kind === "added"
        ? `${plural(count, "line")} added`
        : `${plural(count, "line")} changed`;
    for (let index = change.from; index < change.to; index += 1) {
      const line = doc.line(index + 1);
      builder.add(
        line.from,
        line.from,
        new ChangeMarker(change.kind, title, index === change.from, index === change.to - 1),
      );
    }
  }
  return builder.finish();
}

interface GutterState {
  /** The committed lines, or `null` when there is nothing to compare with. */
  base: readonly string[] | null;
  marks: RangeSet<GutterMarker>;
}

const setBase = StateEffect.define<string | null>();
const setMarks = StateEffect.define<RangeSet<GutterMarker>>();

const gutterState = StateField.define<GutterState>({
  create: () => ({ base: null, marks: RangeSet.empty }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBase)) {
        const base = effect.value === null ? null : splitLines(effect.value);
        return { base, marks: base ? buildMarks(base, tr.state.doc) : RangeSet.empty };
      }
      if (effect.is(setMarks)) return { base: value.base, marks: effect.value };
    }
    if (!tr.docChanged) return value;
    return { base: value.base, marks: value.marks.map(tr.changes) };
  },
});

/** Re-diffs shortly after an edit, at most once per `REFRESH_MS`. */
const refresh = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | null = null;

    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate) {
      if (!update.docChanged || this.timer !== null) return;
      if (!update.state.field(gutterState).base) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        const { base } = this.view.state.field(gutterState);
        if (!base) return;
        this.view.dispatch({ effects: setMarks.of(buildMarks(base, this.view.state.doc)) });
      }, REFRESH_MS);
    }

    destroy() {
      if (this.timer !== null) clearTimeout(this.timer);
    }
  },
);

const theme = EditorView.theme({
  ".cm-gitGutter": {
    width: "8px",
  },
  ".cm-gitGutter .cm-gutterElement": {
    position: "relative",
  },
  ".cm-gitMark": {
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "0",
    width: "3px",
    zIndex: "1",
  },
  ".cm-gitMark-added": {
    backgroundColor: "var(--keel-done)",
  },
  ".cm-gitMark-modified": {
    backgroundColor: "var(--keel-working)",
  },
  ".cm-gitMark-first": {
    borderTopLeftRadius: "1.5px",
    borderTopRightRadius: "1.5px",
  },
  ".cm-gitMark-last": {
    borderBottomLeftRadius: "1.5px",
    borderBottomRightRadius: "1.5px",
  },
  // A small wedge pointing at the code, centred on the seam between lines.
  ".cm-gitMark-deleted": {
    top: "auto",
    width: "0",
    height: "0",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "5px solid var(--keel-dead)",
  },
  ".cm-gitMark-deleted.cm-gitMark-bottom": {
    bottom: "-4px",
  },
  ".cm-gitMark-deleted.cm-gitMark-top": {
    top: "-4px",
    bottom: "auto",
  },
});

/** The gutter column. Place it after `lineNumbers()` so it sits beside the code. */
export function gitGutter(): Extension {
  return [
    gutterState,
    refresh,
    gutter({
      class: "cm-gitGutter",
      markers: (view) => view.state.field(gutterState).marks,
    }),
    theme,
  ];
}

/** Compare against this committed text from now on; `null` clears the gutter. */
export function setGitBase(view: EditorView, base: string | null) {
  view.dispatch({ effects: setBase.of(base) });
}
