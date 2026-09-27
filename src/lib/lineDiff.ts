/**
 * Which lines of a file changed since its last commit, for the editor gutter.
 *
 * A line diff in git's sense: old and new lines are paired along a longest
 * common subsequence (Myers), and every gap between two paired lines is one
 * change. A gap that only adds lines is an addition, one that only removes
 * them is a deletion between its neighbours, and one that does both marks
 * every new line in it as modified — the way VS Code draws its gutter.
 */

export type LineChangeKind = "added" | "modified" | "deleted";

export interface LineChange {
  kind: LineChangeKind;
  /** First changed line of the new text, 0-based. A deletion sits just above it. */
  from: number;
  /** One past the last changed line; equal to `from` for a deletion. */
  to: number;
  /** Lines of the old text this change replaced or removed. */
  removed: number;
}

/**
 * Past this many edits the search costs more than it tells: the differing
 * middle is reported as one change instead.
 */
const MAX_EDITS = 1000;

/**
 * Lines as git counts them: a final newline ends the last line rather than
 * starting an empty one, and a CRLF checkout matches an LF commit.
 */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function lineChanges(
  before: readonly string[],
  after: readonly string[],
): LineChange[] {
  // Most edits touch a small window: whatever matches at both ends is settled.
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start += 1;
  let endA = before.length;
  let endB = after.length;
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  if (start === endA && start === endB) return [];

  const changes: LineChange[] = [];
  let a = start;
  let b = start;
  const gap = (toA: number, toB: number) => {
    const removed = toA - a;
    const added = toB - b;
    if (!removed && !added) return;
    const kind = added === 0 ? "deleted" : removed === 0 ? "added" : "modified";
    changes.push({ kind, from: b, to: toB, removed });
  };
  for (const [pairA, pairB] of commonLines(before, after, start, endA, endB)) {
    gap(pairA, pairB);
    a = pairA + 1;
    b = pairB + 1;
  }
  gap(endA, endB);
  return changes;
}

/**
 * Paired line indices along a longest common subsequence of
 * `before[start, endA)` and `after[start, endB)`, in order. Empty when the
 * two differ by more than the edit budget.
 */
function commonLines(
  before: readonly string[],
  after: readonly string[],
  start: number,
  endA: number,
  endB: number,
): Array<[number, number]> {
  const ids = new Map<string, number>();
  const idOf = (line: string) => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const idsA = before.slice(start, endA).map(idOf);
  const idsB = after.slice(start, endB).map(idOf);

  // A line found on one side only can never pair up, so it stays out of the
  // search. A file rewritten wholesale shrinks to the few lines it kept.
  const inA = new Set(idsA);
  const inB = new Set(idsB);
  const a: number[] = [];
  const b: number[] = [];
  const indexA: number[] = [];
  const indexB: number[] = [];
  idsA.forEach((id, i) => {
    if (!inB.has(id)) return;
    a.push(id);
    indexA.push(start + i);
  });
  idsB.forEach((id, j) => {
    if (!inA.has(id)) return;
    b.push(id);
    indexB.push(start + j);
  });

  const pairs = myers(a, b);
  if (!pairs) return [];
  return pairs.map(([i, j]) => [indexA[i]!, indexB[j]!]);
}

/**
 * The diagonal the furthest path onto diagonal `k` comes from after `d`
 * edits: `k + 1` for a line taken from `b`, `k - 1` for one dropped from `a`.
 * `null` when neither neighbour can step onto `k` without leaving the grid.
 */
function previousDiagonal(
  furthest: (k: number) => number,
  k: number,
  d: number,
  n: number,
  m: number,
): number | null {
  let best = -1;
  let from: number | null = null;
  if (k < d) {
    const x = furthest(k + 1);
    if (x >= 0 && x - (k + 1) < m) {
      best = x;
      from = k + 1;
    }
  }
  if (k > -d) {
    const x = furthest(k - 1);
    if (x >= 0 && x < n && x + 1 > best) from = k - 1;
  }
  return from;
}

/** Myers' O(ND) search, keeping each round's frontier to walk the path back. */
function myers(a: readonly number[], b: readonly number[]): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const limit = Math.min(n + m, MAX_EDITS);
  const offset = limit + 1;
  const frontier = new Int32Array(2 * limit + 3).fill(-1);
  const furthest = (k: number) => frontier[offset + k] ?? -1;
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d += 1) {
    trace.push(frontier.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = 0;
      if (d > 0) {
        const from = previousDiagonal(furthest, k, d, n, m);
        if (from === null) {
          frontier[offset + k] = -1;
          continue;
        }
        x = furthest(from) + (from === k + 1 ? 0 : 1);
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + k] = x;
      if (x === n && y === m) return walkBack(trace, d, n, m);
    }
  }
  return null;
}

function walkBack(
  trace: readonly Int32Array[],
  edits: number,
  n: number,
  m: number,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d -= 1) {
    const round = trace[d]!;
    const furthest = (k: number) => round[k + d] ?? -1;
    const k = x - y;
    const from = previousDiagonal(furthest, k, d, n, m)!;
    const fromX = furthest(from);
    const edgeX = from === k + 1 ? fromX : fromX + 1;
    while (x > edgeX) {
      x -= 1;
      y -= 1;
      pairs.push([x, y]);
    }
    x = fromX;
    y = fromX - from;
  }
  while (x > 0) {
    x -= 1;
    y -= 1;
    pairs.push([x, y]);
  }
  return pairs.reverse();
}
