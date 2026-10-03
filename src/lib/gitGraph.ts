/**
 * The lanes of a commit graph, one row per commit, newest first.
 *
 * Each lane is a line of descent waiting for the commit it leads to. A commit
 * lands in the lane already waiting for it (or a fresh one, if it is a tip
 * nobody points at), every other lane waiting for it ends there, and its
 * parents carry on below: the first in its own lane, any others in lanes of
 * their own. Lanes never move sideways once they exist, so a row can be drawn
 * from just itself — straight lines for what passes through, a curve for what
 * joins or leaves the commit.
 *
 * Colours belong to a lane for as long as it lives, so one branch keeps one
 * colour all the way down.
 */

export interface GraphEdge {
  lane: number;
  color: number;
}

export interface GraphRow {
  /** The lane the commit's dot sits in. */
  lane: number;
  color: number;
  /** Lanes that run straight through this row without touching the commit. */
  through: GraphEdge[];
  /** Lanes that arrive from above and end at the commit. */
  incoming: GraphEdge[];
  /** Lanes the commit's parents continue in below it, first parent first. */
  outgoing: GraphEdge[];
  /** Every lane alive below this row: what a gap under it has to keep drawing. */
  after: GraphEdge[];
  /** Lanes this row needs room for. */
  width: number;
}

export interface GraphCommit {
  hash: string;
  parents: string[];
}

function firstFree(lanes: (string | null)[]): number {
  const free = lanes.indexOf(null);
  return free === -1 ? lanes.length : free;
}

export function layoutGraph(commits: GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const incomingLanes: number[] = [];
    lanes.forEach((hash, index) => {
      if (hash === commit.hash) incomingLanes.push(index);
    });

    let lane = incomingLanes[0] ?? -1;
    if (lane === -1) {
      lane = firstFree(lanes);
      lanes[lane] = commit.hash;
      colors[lane] = nextColor++;
    }

    const color = colors[lane] ?? 0;
    const edge = (index: number): GraphEdge => ({ lane: index, color: colors[index] ?? 0 });
    const through = lanes.flatMap((hash, index) =>
      hash !== null && hash !== commit.hash ? [edge(index)] : [],
    );
    const incoming = incomingLanes.map(edge);
    const widthBefore = lanes.length;

    // Every other lane that was waiting for this commit ends here.
    for (const index of incomingLanes) {
      if (index !== lane) lanes[index] = null;
    }

    const outgoing: GraphEdge[] = [];
    const [first, ...rest] = commit.parents;
    if (first === undefined) {
      lanes[lane] = null;
    } else {
      const waiting = lanes.indexOf(first);
      if (waiting !== -1 && waiting !== lane) {
        // Another lane already leads to the parent: join it rather than
        // running two lines side by side to the same place.
        lanes[lane] = null;
        outgoing.push(edge(waiting));
      } else {
        lanes[lane] = first;
        outgoing.push(edge(lane));
      }
    }
    for (const parent of rest) {
      const waiting = lanes.indexOf(parent);
      if (waiting !== -1) {
        outgoing.push(edge(waiting));
        continue;
      }
      const index = firstFree(lanes);
      lanes[index] = parent;
      colors[index] = nextColor++;
      outgoing.push(edge(index));
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
      colors.pop();
    }

    const after = lanes.flatMap((hash, index) => (hash !== null ? [edge(index)] : []));
    const reach = Math.max(
      lane + 1,
      widthBefore,
      lanes.length,
      ...outgoing.map((item) => item.lane + 1),
    );
    rows.push({ lane, color, through, incoming, outgoing, after, width: reach });
  }
  return rows;
}
