/**
 * The shape of a diff on screen, worked out without touching the DOM: which
 * removed line a new one replaced, what changed inside it word by word, how
 * the two sides line up when shown side by side, and where each change
 * starts so you can step between them.
 */

import type { DiffLine, GitHunk } from "./workspace.ts";

export type Range = readonly [number, number];

// ---- Inside a line ------------------------------------------------------------

interface Token {
  text: string;
  start: number;
}

/** Words, runs of space, and each punctuation mark on its own. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/\w+|\s+|[^\w\s]/g)) {
    tokens.push({ text: match[0], start: match.index });
  }
  return tokens;
}

/** Past this many token pairs, a word diff costs more than it shows. */
const MAX_PAIRS = 160_000;

/** Below this share in common, two lines are different lines, not an edit. */
const MIN_SIMILARITY = 0.35;

function merge(ranges: [number, number][]): Range[] {
  const out: [number, number][] = [];
  for (const range of ranges) {
    const last = out[out.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else out.push([range[0], range[1]]);
  }
  return out;
}

/**
 * What changed between a removed line and the line that replaced it, as
 * character ranges on each — or null when they have too little in common for
 * the detail to help.
 */
export function wordDiff(
  before: string,
  after: string,
): { removed: Range[]; added: Range[] } | null {
  if (before === after) return { removed: [], added: [] };
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length * b.length > MAX_PAIRS) return null;

  // Longest common subsequence of tokens, filled from the end.
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i]!.text === b[j]!.text
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }

  const removed: [number, number][] = [];
  const added: [number, number][] = [];
  let shared = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]!.text === b[j]!.text) {
      shared += a[i]!.text.length;
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      removed.push([a[i]!.start, a[i]!.start + a[i]!.text.length]);
      i++;
    } else {
      added.push([b[j]!.start, b[j]!.start + b[j]!.text.length]);
      j++;
    }
  }
  for (; i < a.length; i++) removed.push([a[i]!.start, a[i]!.start + a[i]!.text.length]);
  for (; j < b.length; j++) added.push([b[j]!.start, b[j]!.start + b[j]!.text.length]);

  const similarity = (2 * shared) / Math.max(1, before.length + after.length);
  if (similarity < MIN_SIMILARITY) return null;
  return { removed: merge(removed), added: merge(added) };
}

// ---- Within a hunk ------------------------------------------------------------

/**
 * Each removed line with the added line that took its place: within a run of
 * removals followed by a run of additions, the first pairs with the first,
 * and so on. Returns a partner index for every paired line, both ways.
 */
export function pairLines(lines: readonly DiffLine[]): Map<number, number> {
  const pairs = new Map<number, number>();
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.kind !== "del") {
      index++;
      continue;
    }
    const removed: number[] = [];
    while (lines[index]?.kind === "del" || lines[index]?.kind === "meta") {
      if (lines[index]?.kind === "del") removed.push(index);
      index++;
    }
    const added: number[] = [];
    while (lines[index]?.kind === "add" || lines[index]?.kind === "meta") {
      if (lines[index]?.kind === "add") added.push(index);
      index++;
    }
    const count = Math.min(removed.length, added.length);
    for (let k = 0; k < count; k++) {
      pairs.set(removed[k]!, added[k]!);
      pairs.set(added[k]!, removed[k]!);
    }
  }
  return pairs;
}

/** One row of a side-by-side diff: an index into the hunk's lines per side. */
export interface SplitRow {
  left: number | null;
  right: number | null;
}

/**
 * The hunk as two columns. Unchanged lines sit on both sides; a block of
 * removals and the additions after it share rows, the shorter side padded
 * with blanks; git's "no newline" note stays beside the line it is about.
 */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === "ctx") {
      rows.push({ left: index, right: index });
      index++;
      continue;
    }
    if (line.kind === "meta") {
      const before = lines[index - 1]?.kind;
      rows.push({
        left: before === "add" ? null : index,
        right: before === "del" ? null : index,
      });
      index++;
      continue;
    }
    const removed: number[] = [];
    const added: number[] = [];
    while (lines[index]?.kind === "del") removed.push(index++);
    while (lines[index]?.kind === "add") added.push(index++);
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      rows.push({ left: removed[k] ?? null, right: added[k] ?? null });
    }
  }
  return rows;
}

/** Where a change starts: a run of removed and added lines inside a hunk. */
export interface ChangeStart {
  hunk: number;
  line: number;
}

export function changeStarts(hunks: readonly GitHunk[]): ChangeStart[] {
  const starts: ChangeStart[] = [];
  hunks.forEach((hunk, h) => {
    let inside = false;
    hunk.lines.forEach((line, l) => {
      const change = line.kind === "add" || line.kind === "del";
      if (change && !inside) starts.push({ hunk: h, line: l });
      if (line.kind !== "meta") inside = change;
    });
  });
  return starts;
}

/**
 * Unchanged lines git left out between one hunk and the next, counted on
 * the old side. The first gap is what comes before the first hunk.
 */
export function hiddenBefore(hunks: readonly GitHunk[], index: number): number {
  const hunk = hunks[index];
  if (!hunk) return 0;
  const previous = hunks[index - 1];
  const start = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
  if (!previous) return Math.max(0, start - 1);
  const previousEnd = previous.oldStart + previous.oldLines;
  return Math.max(0, start - previousEnd);
}

// ---- Painting a line ----------------------------------------------------------

export interface StyledSpan {
  from: number;
  to: number;
  /** Index into the editor's syntax styles. */
  style: number;
}

export interface Segment {
  text: string;
  style: number | null;
  /** Inside a word-level change. */
  changed: boolean;
}

/** Cut a line where its syntax colour or its changed-ness changes. */
export function segments(
  text: string,
  syntax: readonly StyledSpan[],
  changed: readonly Range[],
): Segment[] {
  if (!syntax.length && !changed.length) return [{ text, style: null, changed: false }];
  const cuts = new Set<number>([0, text.length]);
  for (const span of syntax) {
    cuts.add(Math.max(0, Math.min(text.length, span.from)));
    cuts.add(Math.max(0, Math.min(text.length, span.to)));
  }
  for (const [from, to] of changed) {
    cuts.add(Math.max(0, Math.min(text.length, from)));
    cuts.add(Math.max(0, Math.min(text.length, to)));
  }
  const points = [...cuts].sort((x, y) => x - y);
  const out: Segment[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    const from = points[k]!;
    const to = points[k + 1]!;
    if (from === to) continue;
    const span = syntax.find((item) => item.from <= from && item.to >= to);
    const inChange = changed.some(([start, end]) => start <= from && end >= to);
    const last = out[out.length - 1];
    const style = span?.style ?? null;
    if (last && last.style === style && last.changed === inChange) {
      last.text += text.slice(from, to);
    } else {
      out.push({ text: text.slice(from, to), style, changed: inChange });
    }
  }
  return out;
}
