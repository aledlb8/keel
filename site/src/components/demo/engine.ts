import type { AgentId, PaneStatus } from "../marks";

export type LineKind =
  | "banner"
  | "user"
  | "say"
  | "tool"
  | "detail"
  | "add"
  | "del"
  | "ok"
  | "warn"
  | "muted"
  | "cmd"
  | "out";

export interface Line {
  id: number;
  kind: LineKind;
  text: string;
}

export interface Step {
  kind: LineKind;
  text: string;
  /** Milliseconds before this line appears. */
  wait: number;
}

export interface Script {
  title: string;
  prompt: string;
  cwd: string;
  steps: Step[];
}

export interface Pane {
  id: string;
  agent: AgentId;
  deck: string;
  /** What the sidebar calls this pane: the brief of its current work. */
  title: string;
  status: PaneStatus;
  lines: Line[];
  cwd: string;
  queue: Step[];
  nextAt: number;
  startedAt: number;
  finishedIn: number | null;
  verb: string;
  muted: boolean;
}

export interface Deck {
  id: string;
  name: string;
  /** Each deck remembers which terminal you were in. */
  focused: string | null;
}

export interface News {
  paneId: string;
  at: number;
}

export interface DemoState {
  now: number;
  panes: Pane[];
  decks: Deck[];
  deck: string;
  focused: string | null;
  news: News | null;
  overlay: null | "launch" | "overview";
  maximized: string | null;
  usage: { claude: number; codex: number };
  seq: number;
}

let lineSeq = 1;
const line = (kind: LineKind, text: string): Line => ({
  id: lineSeq++,
  kind,
  text,
});

const s = (kind: LineKind, text: string, wait = 700): Step => ({
  kind,
  text,
  wait,
});

/* -------------------------------------------------------------------------- */
/* Work the agents do. It is Keel's own backlog, so the demo is about itself.  */
/* -------------------------------------------------------------------------- */

export const SCRIPTS: Script[] = [
  {
    title: "Retry failed layout writes",
    prompt: "Make the persist queue retry a failed write before it gives up",
    cwd: "~/code/keel/src/lib",
    steps: [
      s("say", "I'll look at how writes are queued first.", 900),
      s("tool", "Read src/lib/persistQueue.ts", 1100),
      s("detail", "Read 142 lines", 500),
      s("tool", "Search \"flushPending\" in src", 1000),
      s("detail", "Found 4 matches in 2 files", 500),
      s("say", "Writes are coalesced, but a rejected invoke drops the batch.", 1500),
      s("tool", "Edit src/lib/persistQueue.ts", 1300),
      s("del", "-    await invoke(\"save_workspace\", { state });", 250),
      s("add", "+    await withRetry(() => invoke(\"save_workspace\", { state }), {", 250),
      s("add", "+      attempts: 3,", 200),
      s("add", "+      backoff: (n) => 120 * 2 ** n,", 200),
      s("add", "+    });", 200),
      s("tool", "Run pnpm test persistQueue", 1400),
      s("ok", "✓ 23 passed (1.2s)", 1900),
      s("say", "A failed write now retries twice with backoff before it surfaces an error.", 900),
    ],
  },
  {
    title: "Capture Codex session ids",
    prompt: "Restore should resume the exact Codex conversation, not the newest one",
    cwd: "~/code/keel/src-tauri/src",
    steps: [
      s("tool", "Read src-tauri/src/sessions.rs", 1000),
      s("detail", "Read 388 lines", 400),
      s("tool", "Read src-tauri/src/agent_hooks.rs", 1100),
      s("say", "The SessionStart hook already carries the real id. Save it on arrival.", 1600),
      s("tool", "Edit src-tauri/src/sessions.rs", 1200),
      s("add", "+    pane.session = Some(event.session_id.clone());", 250),
      s("add", "+    store.persist_soon();", 250),
      s("tool", "Run cargo test sessions", 1600),
      s("ok", "✓ test result: ok. 41 passed; 0 failed", 2200),
      s("say", "Codex panes now resume by id with `codex resume <id>`.", 900),
    ],
  },
  {
    title: "Tests for the balanced grid",
    prompt: "Cover gridRows for every count up to 128 panes",
    cwd: "~/code/keel/src/lib",
    steps: [
      s("tool", "Read src/lib/terminalLayout.ts", 900),
      s("say", "Invariants: no empty slots, and row lengths differ by at most one.", 1400),
      s("tool", "Write src/lib/terminalLayout.test.ts", 1300),
      s("add", "+  for (let n = 1; n <= 128; n++) {", 200),
      s("add", "+    const rows = gridRows(n);", 200),
      s("add", "+    assert.equal(sum(rows), n);", 200),
      s("add", "+    assert.ok(max(rows) - min(rows) <= 1);", 200),
      s("tool", "Run pnpm test terminalLayout", 1300),
      s("ok", "✓ 128 layouts checked", 1600),
    ],
  },
  {
    title: "Hold the island on hover",
    prompt: "The island shouldn't collapse while I'm hovering it",
    cwd: "~/code/keel/src/components",
    steps: [
      s("tool", "Read src/components/Island.tsx", 1000),
      s("detail", "Read 612 lines", 400),
      s("say", "The hold timer keeps running under the pointer. Pause it on enter.", 1500),
      s("tool", "Edit src/components/Island.tsx", 1200),
      s("add", "+  onPointerEnter={() => hold.pause()}", 220),
      s("add", "+  onPointerLeave={() => hold.resume()}", 220),
      s("tool", "Run pnpm typecheck", 1500),
      s("ok", "✓ No errors", 1300),
    ],
  },
  {
    title: "Clippy warnings in vpn.rs",
    prompt: "Fix the clippy warnings in the VPN module",
    cwd: "~/code/keel/src-tauri",
    steps: [
      s("tool", "Run pnpm rust:lint", 1200),
      s("warn", "warning: this `if let` can be collapsed into the outer `match`", 900),
      s("warn", "warning: redundant clone", 400),
      s("tool", "Edit src-tauri/src/vpn.rs", 1400),
      s("del", "-            let route = route.clone();", 220),
      s("tool", "Run pnpm rust:lint", 1500),
      s("ok", "✓ Finished with 0 warnings", 1700),
    ],
  },
  {
    title: "Watcher on large repos",
    prompt: "Profile the file watcher on a 40k file repo",
    cwd: "~/code/keel/src-tauri/src",
    steps: [
      s("tool", "Read src-tauri/src/watch.rs", 1000),
      s("say", "Every event re-reads git status. Debounce the burst instead.", 1700),
      s("tool", "Edit src-tauri/src/watch.rs", 1200),
      s("add", "+const SETTLE: Duration = Duration::from_millis(180);", 250),
      s("tool", "Run cargo bench watch", 1900),
      s("ok", "✓ status refreshes 38 → 3 per burst", 1600),
    ],
  },
  {
    title: "Release notes for 0.2",
    prompt: "Draft release notes from the commits since v0.1.0",
    cwd: "~/code/keel",
    steps: [
      s("tool", "Run git log v0.1.0..HEAD --oneline", 1000),
      s("detail", "38 commits", 400),
      s("say", "Grouping by what a user would notice.", 1300),
      s("tool", "Write docs/release-0.2.md", 1400),
      s("add", "+ Codex conversations restore by id", 250),
      s("add", "+ The shell fades while the window is unfocused", 250),
      s("add", "+ Agents adopt the shell they run in", 250),
      s("ok", "✓ Draft saved", 1200),
    ],
  },
];

const VERBS = [
  "Thinking",
  "Reading",
  "Tracing",
  "Weighing",
  "Editing",
  "Checking",
  "Planning",
];

/** Turn anything a visitor types into a believable turn of work. */
export function scriptFromPrompt(prompt: string, seed: number): Script {
  const base = SCRIPTS[seed % SCRIPTS.length]!;
  const file = ["src/state/store.ts", "src/components/Canvas.tsx", "src/lib/launch.ts"][seed % 3]!;
  const brief = prompt.length > 34 ? `${prompt.slice(0, 32).trimEnd()}…` : prompt;
  return {
    title: brief,
    prompt,
    cwd: base.cwd,
    steps: [
      s("say", "On it. Finding where that lives.", 900),
      s("tool", `Search "${prompt.split(/\s+/).slice(0, 2).join(" ")}" in src`, 1100),
      s("tool", `Read ${file}`, 1000),
      s("tool", `Edit ${file}`, 1500),
      s("add", "+  // " + brief, 250),
      s("tool", "Run pnpm test", 1400),
      s("ok", "✓ 214 passed", 1600),
      s("say", "Done. The change is in place and the suite is green.", 900),
    ],
  };
}

export function banner(agent: AgentId, cwd: string): Line[] {
  if (agent === "shell") return [];
  return [line("banner", cwd)];
}

const SHELL: Record<string, string[]> = {
  "git status": [
    "On branch main",
    "Changes not staged for commit:",
    "  modified:   src/lib/persistQueue.ts",
    "  modified:   src-tauri/src/sessions.rs",
  ],
  ls: ["docs  scripts  src  src-tauri  package.json  README.md"],
  "pnpm test": ["✓ 214 passed (38 files)", "Done in 4.1s"],
  "pnpm check": ["typecheck ✓  test ✓  fmt ✓  clippy ✓  cargo test ✓"],
  "git log --oneline -3": [
    "ec9d96a feat(window): fade the shell while the window is unfocused",
    "899491c feat(agents): adopt a shell while a CLI is running in it",
    "0f89197 fix(activity): ignore launch enters and decoration",
  ],
};

export function shellReply(cmd: string): Line[] {
  const key = cmd.trim();
  if (!key) return [line("cmd", "")];
  const out = SHELL[key] ??
    SHELL[key.replace(/\s+/g, " ")] ?? [
      `${key.split(" ")[0]}: this demo shell knows git status, ls, pnpm test and pnpm check`,
    ];
  return [line("cmd", key), ...out.map((t) => line(t.startsWith("✓") ? "ok" : "out", t))];
}

/* -------------------------------------------------------------------------- */
/* The reducer                                                                 */
/* -------------------------------------------------------------------------- */

export type Action =
  | { type: "tick"; now: number }
  | { type: "focus"; paneId: string | null }
  | { type: "start"; paneId: string; script: Script }
  | { type: "shell"; paneId: string; cmd: string }
  | { type: "interrupt"; paneId: string }
  | { type: "close"; paneId: string }
  | { type: "launch"; agents: AgentId[] }
  | { type: "deck"; deck: string }
  | { type: "add-deck" }
  | { type: "overlay"; overlay: DemoState["overlay"] }
  | { type: "maximize"; paneId: string | null }
  | { type: "next-waiting" }
  | { type: "dismiss-news" }
  | { type: "mute"; paneId: string };

function makePane(
  id: string,
  agent: AgentId,
  deck: string,
  cwd = "~/code/keel",
): Pane {
  return {
    id,
    agent,
    deck,
    title: agent === "shell" ? "Shell" : "New session",
    status: "idle",
    lines: banner(agent, cwd),
    cwd,
    queue: [],
    nextAt: 0,
    startedAt: 0,
    finishedIn: null,
    verb: VERBS[0]!,
    muted: false,
  };
}

function beginWork(p: Pane, script: Script, now: number, seq: number): Pane {
  return {
    ...p,
    title: script.title,
    status: "working",
    cwd: script.cwd,
    lines: [...p.lines, line("user", script.prompt)].slice(-80),
    queue: script.steps,
    nextAt: now + (script.steps[0]?.wait ?? 600),
    startedAt: now,
    finishedIn: null,
    verb: VERBS[seq % VERBS.length]!,
  };
}

export function initialState(now: number): DemoState {
  const d1 = "d1";
  const d2 = "d2";
  let panes: Pane[] = [
    makePane("p1", "claude", d1),
    makePane("p2", "codex", d1),
    makePane("p3", "gemini", d1),
    makePane("p4", "shell", d1),
    makePane("p5", "opencode", d2),
    makePane("p6", "grok", d2),
  ];
  const shell = panes[3]!;
  panes[3] = {
    ...shell,
    lines: [...shellReply("git log --oneline -3"), ...shellReply("pnpm check")],
  };
  // Staggered starts, so finishes arrive one at a time.
  panes = panes.map((p) => {
    if (p.id === "p1") return beginWork(p, SCRIPTS[0]!, now, 0);
    if (p.id === "p2") return beginWork(p, SCRIPTS[1]!, now - 4000, 1);
    if (p.id === "p5") return beginWork(p, SCRIPTS[4]!, now - 2000, 2);
    if (p.id === "p6") {
      const done = beginWork(p, SCRIPTS[6]!, now - 30000, 3);
      return { ...done, status: "idle" as const };
    }
    return p;
  });
  // p6 already finished before you arrived: give it its transcript.
  panes = panes.map((p) =>
    p.id === "p6"
      ? {
          ...p,
          queue: [],
          lines: [
            ...p.lines,
            ...SCRIPTS[6]!.steps.map((st) => line(st.kind, st.text)),
          ],
          finishedIn: 14,
        }
      : p,
  );
  return {
    now,
    panes,
    decks: [
      { id: d1, name: "Deck 1", focused: "p3" },
      { id: d2, name: "Deck 2", focused: "p5" },
    ],
    deck: d1,
    focused: "p3",
    news: null,
    overlay: null,
    maximized: null,
    usage: { claude: 61, codex: 38 },
    seq: 10,
  };
}

/** Is this pane in front of you right now? Finishing there is never news. */
function lookingAt(state: DemoState, p: Pane) {
  return state.focused === p.id && state.deck === p.deck && !state.overlay;
}

export function reducer(state: DemoState, action: Action): DemoState {
  switch (action.type) {
    case "tick": {
      const now = action.now;
      let news = state.news;
      let usage = state.usage;
      let changed = false;
      const panes = state.panes.map((p) => {
        if (p.status !== "working" || now < p.nextAt) return p;
        changed = true;
        const [head, ...rest] = p.queue;
        if (!head) {
          const seen = lookingAt(state, p);
          if (!seen) news = { paneId: p.id, at: now };
          if (p.agent === "claude" || p.agent === "codex") {
            usage = {
              ...usage,
              [p.agent]: Math.min(97, usage[p.agent] + 3),
            };
          }
          return {
            ...p,
            status: seen ? ("idle" as const) : ("done" as const),
            queue: [],
            finishedIn: Math.round((now - p.startedAt) / 1000),
          };
        }
        const next = rest[0];
        return {
          ...p,
          lines: [...p.lines, line(head.kind, head.text)].slice(-80),
          queue: rest,
          nextAt: next ? now + next.wait : now + 700,
          verb:
            head.kind === "tool"
              ? head.text.startsWith("Run")
                ? "Running"
                : head.text.startsWith("Edit") || head.text.startsWith("Write")
                  ? "Editing"
                  : "Reading"
              : p.verb,
        };
      });
      if (!changed) return { ...state, now };
      return { ...state, now, panes, news, usage };
    }
    case "focus": {
      if (!action.paneId) return { ...state, focused: null };
      const target = state.panes.find((p) => p.id === action.paneId);
      if (!target) return state;
      return {
        ...state,
        focused: target.id,
        deck: target.deck,
        decks: state.decks.map((d) =>
          d.id === target.deck ? { ...d, focused: target.id } : d,
        ),
        overlay: null,
        maximized:
          state.maximized && state.maximized !== target.id ? null : state.maximized,
        news: state.news?.paneId === target.id ? null : state.news,
        panes: state.panes.map((p) =>
          p.id === target.id && p.status === "done" ? { ...p, status: "idle" } : p,
        ),
      };
    }
    case "start":
      return {
        ...state,
        seq: state.seq + 1,
        panes: state.panes.map((p) =>
          p.id === action.paneId
            ? beginWork(p, action.script, state.now, state.seq)
            : p,
        ),
      };
    case "shell":
      return {
        ...state,
        panes: state.panes.map((p) =>
          p.id === action.paneId
            ? {
                ...p,
                lines:
                  action.cmd.trim() === "clear"
                    ? []
                    : [...p.lines, ...shellReply(action.cmd)].slice(-80),
              }
            : p,
        ),
      };
    case "interrupt":
      return {
        ...state,
        panes: state.panes.map((p) =>
          p.id === action.paneId && p.status === "working"
            ? {
                ...p,
                status: "idle",
                queue: [],
                lines: [...p.lines, line("warn", "Interrupted. What should I do instead?")],
              }
            : p,
        ),
      };
    case "close": {
      const panes = state.panes.filter((p) => p.id !== action.paneId);
      const sameDeck = panes.filter((p) => p.deck === state.deck);
      return {
        ...state,
        panes,
        focused:
          state.focused === action.paneId ? (sameDeck[0]?.id ?? null) : state.focused,
        maximized: state.maximized === action.paneId ? null : state.maximized,
        news: state.news?.paneId === action.paneId ? null : state.news,
      };
    }
    case "launch": {
      let seq = state.seq;
      const fresh = action.agents.map((a) => makePane(`p${++seq}`, a, state.deck));
      return {
        ...state,
        seq,
        panes: [...state.panes, ...fresh],
        focused: fresh[0]?.id ?? state.focused,
        overlay: null,
        maximized: null,
      };
    }
    case "deck": {
      const onDeck = state.panes.filter((p) => p.deck === action.deck);
      const remembered = state.decks.find((d) => d.id === action.deck)?.focused;
      const keep = onDeck.find((p) => p.id === remembered);
      const target = keep ?? onDeck[0];
      const next = {
        ...state,
        deck: action.deck,
        overlay: null,
        maximized: null,
        focused: target?.id ?? null,
      };
      // Arriving on a deck is looking at its focused terminal.
      return target ? reducer(next, { type: "focus", paneId: target.id }) : next;
    }
    case "add-deck": {
      const n = state.decks.length + 1;
      const id = `d${state.seq + 1}`;
      return {
        ...state,
        seq: state.seq + 1,
        decks: [...state.decks, { id, name: `Deck ${n}`, focused: null }],
        deck: id,
        overlay: null,
        maximized: null,
        focused: null,
      };
    }
    case "overlay":
      return { ...state, overlay: action.overlay };
    case "maximize":
      return { ...state, maximized: action.paneId };
    case "next-waiting": {
      const waiting = state.panes
        .filter((p) => p.status === "done")
        .sort((a, b) => a.startedAt - b.startedAt);
      const target = waiting[0];
      if (!target) return state;
      return reducer(state, { type: "focus", paneId: target.id });
    }
    case "dismiss-news":
      return { ...state, news: null };
    case "mute":
      return {
        ...state,
        panes: state.panes.map((p) =>
          p.id === action.paneId ? { ...p, muted: !p.muted } : p,
        ),
      };
  }
}
