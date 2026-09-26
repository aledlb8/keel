"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
} from "react";
import { Minus, Plus } from "lucide-react";

import { AGENTS, AgentMark, StatusDot, gridRects, type AgentId } from "../marks";
import { Rail, Schematic, Sidebar, StatusBar, Titlebar } from "./Chrome";
import { PaneView } from "./Pane";
import { SCRIPTS, initialState, reducer, type Action, type DemoState } from "./engine";

/* -------------------------------------------------------------------------- */
/* The chime: two soft sine partials, the app's "an agent is done".            */
/* -------------------------------------------------------------------------- */

let audio: AudioContext | null = null;
function chime() {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    [
      [880, 0],
      [1318.5, 0.09],
    ].forEach(([freq, delay]) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq!;
      gain.gain.setValueAtTime(0, t + delay!);
      gain.gain.linearRampToValueAtTime(0.07, t + delay! + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay! + 0.9);
      osc.connect(gain).connect(audio!.destination);
      osc.start(t + delay!);
      osc.stop(t + delay! + 1);
    });
  } catch {
    /* no audio, no chime */
  }
}

/* -------------------------------------------------------------------------- */

function Canvas({
  state,
  dispatch,
  grab,
}: {
  state: DemoState;
  dispatch: Dispatch<Action>;
  grab: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 600 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onDeck = state.panes.filter((p) => p.deck === state.deck);
  const rects = gridRects(onDeck.length, size.w, size.h, 10);
  const index = new Map(onDeck.map((p, i) => [p.id, i]));

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      {state.panes.map((p) => {
        const i = index.get(p.id);
        const hidden =
          i === undefined || (state.maximized !== null && state.maximized !== p.id);
        const r =
          state.maximized === p.id
            ? { x: 0, y: 0, w: size.w, h: size.h }
            : i !== undefined
              ? rects[i]!
              : { x: 0, y: 0, w: size.w, h: size.h };
        return (
          <motion.div
            key={p.id}
            className="absolute"
            initial={{ opacity: 0, scale: 0.96, left: r.x, top: r.y, width: r.w, height: r.h }}
            animate={{
              left: r.x,
              top: r.y,
              width: r.w,
              height: r.h,
              opacity: hidden ? 0 : 1,
              scale: hidden ? 0.985 : 1,
            }}
            transition={{ type: "spring", stiffness: 300, damping: 34, mass: 0.9 }}
            style={{ pointerEvents: hidden ? "none" : "auto", zIndex: state.maximized === p.id ? 2 : 1 }}
            aria-hidden={hidden}
          >
            <PaneView
              pane={p}
              focused={state.focused === p.id}
              now={state.now}
              seq={state.seq}
              maximized={state.maximized === p.id}
              grab={grab}
              dispatch={dispatch}
            />
          </motion.div>
        );
      })}

      {onDeck.length === 0 && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-[15px] font-medium text-ink">This deck is empty</p>
            <p className="max-w-[260px] text-[12px] leading-5 text-faint">
              Agents on your other decks keep running while you set this one up.
            </p>
            <button
              type="button"
              onClick={() => dispatch({ type: "overlay", overlay: "launch" })}
              className="mt-1 h-8 rounded-[8px] bg-ink px-3.5 text-[12px] font-semibold text-black hover:bg-white"
            >
              Add terminals
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function LaunchDialog({
  state,
  dispatch,
}: {
  state: DemoState;
  dispatch: Dispatch<Action>;
}) {
  const [counts, setCounts] = useState<Partial<Record<AgentId, number>>>({ claude: 1 });
  const choices: AgentId[] = ["claude", "codex", "gemini", "opencode", "grok", "aider", "goose", "shell"];
  const picked = choices.flatMap((a) => Array.from({ length: counts[a] ?? 0 }, () => a));
  const onDeck = state.panes.filter((p) => p.deck === state.deck);
  const total = onDeck.length + picked.length;
  const bump = (a: AgentId, d: number) =>
    setCounts((c) => ({ ...c, [a]: Math.max(0, Math.min(4, (c[a] ?? 0) + d)) }));
  const full = total > 9;

  return (
    <motion.div
      role="dialog"
      aria-label="Add terminals"
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="sheen w-[560px] overflow-hidden rounded-[14px] bg-raised shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.06)]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="px-5 pt-4 pb-3">
        <p className="text-[15px] font-semibold text-ink">Add terminals</p>
        <p className="text-[12px] text-faint">
          The deck rebalances to fit everything, existing panes included.
        </p>
      </div>
      <div className="flex gap-4 px-5 pb-4">
        <div className="grid flex-1 grid-cols-1 gap-px">
          {choices.map((a) => {
            const n = counts[a] ?? 0;
            return (
              <div
                key={a}
                className={`flex h-9 items-center gap-2.5 rounded-[8px] px-2 text-[13px] ${n ? "bg-white/[0.06] text-ink" : "text-dim"}`}
              >
                <AgentMark agent={a} size={18} />
                <span className="flex-1">{AGENTS[a].name}</span>
                <button
                  type="button"
                  aria-label={`Fewer ${AGENTS[a].name}`}
                  onClick={() => bump(a, -1)}
                  className="grid size-6 place-items-center rounded-[6px] text-faint hover:bg-veil-2 hover:text-ink"
                >
                  <Minus size={12} />
                </button>
                <span className="w-3 text-center text-[12px] tabular-nums">{n}</span>
                <button
                  type="button"
                  aria-label={`More ${AGENTS[a].name}`}
                  onClick={() => bump(a, 1)}
                  className="grid size-6 place-items-center rounded-[6px] text-faint hover:bg-veil-2 hover:text-ink"
                >
                  <Plus size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex w-[210px] flex-col gap-2">
          <Schematic
            panes={onDeck}
            newAgents={picked}
            className="aspect-[16/11] w-full rounded-[8px] bg-black/40 p-0"
          />
          <p className="text-[11px] leading-4 text-faint">
            {total === 0
              ? "Pick at least one."
              : full
                ? "The demo stops at nine panes a deck."
                : `${total} pane${total === 1 ? "" : "s"} on this deck after launch.`}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 bg-black/20 px-5 py-3">
        <button
          type="button"
          onClick={() => dispatch({ type: "overlay", overlay: null })}
          className="h-8 rounded-[8px] px-3 text-[12px] text-dim hover:bg-veil-2 hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={picked.length === 0 || full}
          onClick={() => dispatch({ type: "launch", agents: picked })}
          className="h-8 rounded-[8px] bg-ink px-3.5 text-[12px] font-semibold text-black hover:bg-white disabled:opacity-40"
        >
          Launch {picked.length || ""} {picked.length === 1 ? "terminal" : "terminals"}
        </button>
      </div>
    </motion.div>
  );
}

function Overview({
  state,
  dispatch,
}: {
  state: DemoState;
  dispatch: Dispatch<Action>;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="absolute inset-0 z-20 overflow-hidden rounded-[12px] bg-[#0c0c0c]/95 p-6 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) dispatch({ type: "overlay", overlay: null });
      }}
    >
      <div className="mb-4 flex items-baseline gap-3">
        <p className="text-[15px] font-semibold text-ink">Every deck in keel</p>
        <p className="text-[12px] text-faint">Everything here is still running. Pick one to go there.</p>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {state.decks.map((d, i) => {
          const panes = state.panes.filter((p) => p.deck === d.id);
          const brief = panes.filter((p) => p.agent !== "shell").map((p) => p.title).slice(0, 2);
          return (
            <motion.button
              key={d.id}
              type="button"
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay: 0.04 * i, type: "spring", stiffness: 380, damping: 30 }}
              onClick={() => dispatch({ type: "deck", deck: d.id })}
              className={`sheen flex flex-col gap-2 rounded-[12px] bg-chrome p-2.5 text-left transition-shadow hover:shadow-[0_0_0_1px_rgba(255,255,255,0.2)] ${
                d.id === state.deck ? "shadow-[0_0_0_1px_rgba(255,255,255,0.3)]" : ""
              }`}
            >
              {panes.length ? (
                <Schematic panes={panes} className="aspect-[16/10] w-full" />
              ) : (
                <div className="grid aspect-[16/10] w-full place-items-center rounded-[6px] bg-black/30 text-[11px] text-faint">
                  Empty
                </div>
              )}
              <div className="px-0.5">
                <div className="flex items-center gap-2 text-[12px] text-ink">
                  <span className="font-medium">{d.name}</span>
                  <span className="text-faint tabular-nums">Ctrl+{i + 1}</span>
                  <span className="ml-auto flex gap-1">
                    {panes.some((p) => p.status === "working") && <StatusDot status="working" />}
                    {panes.some((p) => p.status === "done") && <StatusDot status="done" />}
                  </span>
                </div>
                <p className="truncate text-[11px] text-faint">
                  {brief.length ? brief.join(", ") : "Nothing running"}
                </p>
              </div>
            </motion.button>
          );
        })}
        <motion.button
          type="button"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.04 * state.decks.length }}
          onClick={() => dispatch({ type: "add-deck" })}
          className="grid min-h-[140px] place-items-center rounded-[12px] border border-dashed border-white/10 text-[12px] text-faint hover:border-white/25 hover:text-ink"
        >
          <span className="flex items-center gap-1.5">
            <Plus size={13} /> New deck
          </span>
        </motion.button>
      </div>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */

export interface WorkspaceProps {
  compact: boolean;
  /** False while scrolled out of view: the simulation pauses. */
  live: boolean;
}

export function Workspace({ compact, live }: WorkspaceProps) {
  const [state, dispatch] = useReducer(reducer, 0, () => initialState(Date.now()));
  const [sound, setSound] = useState(false);
  const [activated, setActivated] = useState(false);
  const [hovered, setHovered] = useState(false);
  const stateRef = useRef(state);
  const lastTouch = useRef(0);
  const newsHold = useRef(false);
  const newsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soundRef = useRef(sound);
  const root = useRef<HTMLDivElement>(null);

  stateRef.current = state;
  soundRef.current = sound;

  // The clock, and an autopilot that hands idle agents work when nobody is typing.
  useEffect(() => {
    if (!live) return;
    let beat = 0;
    const id = setInterval(() => {
      const now = Date.now();
      dispatch({ type: "tick", now });
      beat++;
      if (beat % 28 !== 0) return;
      const s = stateRef.current;
      if (now - lastTouch.current < 14000 || s.overlay) return;
      const working = s.panes.filter((p) => p.status === "working").length;
      if (working >= 3) return;
      const candidates = s.panes.filter(
        (p) => p.agent !== "shell" && p.status === "idle" && p.id !== s.focused,
      );
      const pane = candidates[Math.floor(Math.random() * candidates.length)];
      if (!pane) return;
      const busy = new Set(s.panes.map((p) => p.title));
      const pool = SCRIPTS.filter((sc) => !busy.has(sc.title));
      if (!pool.length) return;
      dispatch({ type: "start", paneId: pane.id, script: pool[Math.floor(Math.random() * pool.length)]! });
    }, 250);
    return () => clearInterval(id);
  }, [live]);

  // News: chime once, hold the island open, then let it settle into a count.
  useEffect(() => {
    if (!state.news) return;
    const pane = stateRef.current.panes.find((p) => p.id === state.news!.paneId);
    if (soundRef.current && pane && !pane.muted) chime();
    const settle = () => {
      if (newsHold.current) {
        newsTimer.current = setTimeout(settle, 800);
        return;
      }
      dispatch({ type: "dismiss-news" });
    };
    newsTimer.current = setTimeout(settle, 6000);
    return () => {
      if (newsTimer.current) clearTimeout(newsTimer.current);
    };
  }, [state.news]);

  const holdNews = useCallback((hold: boolean) => {
    newsHold.current = hold;
  }, []);

  // Keys work while the pointer is over the demo or focus is inside it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inside = root.current?.contains(document.activeElement) || hovered;
      if (!inside) return;
      const s = stateRef.current;
      if (e.key === "F8") {
        e.preventDefault();
        dispatch({ type: "next-waiting" });
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        dispatch({ type: "overlay", overlay: s.overlay === "overview" ? null : "overview" });
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        dispatch({ type: "overlay", overlay: "launch" });
      } else if (e.key === "Escape") {
        if (s.overlay) dispatch({ type: "overlay", overlay: null });
        else if (s.maximized) dispatch({ type: "maximize", paneId: null });
        else if (s.focused) dispatch({ type: "interrupt", paneId: s.focused });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hovered]);

  const touch = () => {
    lastTouch.current = Date.now();
    if (!activated) setActivated(true);
  };

  // Keel fades while it is not the window you are using. Here: once you've
  // clicked in, moving off the demo is "switching away".
  const faded = activated && !hovered;

  return (
    <div
      ref={root}
      onPointerDown={touch}
      onKeyDown={touch}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className="relative flex h-full w-full flex-col overflow-hidden rounded-[14px] bg-void text-left font-sans text-ink shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_2px_0_0_rgba(255,255,255,0.04)_inset]"
      style={{ opacity: faded ? 0.8 : 1, transition: "opacity 500ms var(--ease-keel)" }}
    >
      <Titlebar state={state} dispatch={dispatch} holdNews={holdNews} compact={compact} />
      <div className="relative flex min-h-0 flex-1 gap-2.5 px-2.5 pb-0.5">
        {!compact && <Sidebar state={state} dispatch={dispatch} />}
        <div className="relative flex min-w-0 flex-1">
          <Canvas state={state} dispatch={dispatch} grab={activated} />
          <AnimatePresence>
            {state.overlay === "overview" && <Overview state={state} dispatch={dispatch} />}
          </AnimatePresence>
        </div>
        {!compact && <Rail />}
      </div>
      <StatusBar state={state} dispatch={dispatch} sound={sound} setSound={setSound} />

      <AnimatePresence>
        {state.overlay === "launch" && (
          <motion.div
            key="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 grid place-items-center bg-black/60"
            onPointerDown={() => dispatch({ type: "overlay", overlay: null })}
          >
            <LaunchDialog state={state} dispatch={dispatch} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

