"use client";

import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useRef, useState, type Dispatch } from "react";
import {
  Bell,
  BellOff,
  ChevronDown,
  ChevronRight,
  FileText,
  GitBranch,
  Grid2x2,
  Minus,
  Plus,
  Search,
  Square,
  X,
} from "lucide-react";

import { AGENTS, AgentMark, KeelMark, StatusDot, gridRects } from "../marks";
import type { Action, DemoState, Pane } from "./engine";

const since = (secs: number) =>
  secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;

/* -------------------------------------------------------------------------- */

export function Titlebar({
  state,
  dispatch,
  holdNews,
  compact,
}: {
  state: DemoState;
  dispatch: Dispatch<Action>;
  holdNews: (hold: boolean) => void;
  compact: boolean;
}) {
  return (
    <div className="relative flex h-9 shrink-0 items-center px-3 text-[12px]">
      <div className="flex items-center gap-2 text-ink">
        <KeelMark size={13} />
        <span className="font-medium">Keel</span>
      </div>
      <div className="mx-3 h-3.5 w-px bg-white/10" />
      {!compact && (
        <div className="flex items-center gap-4 text-dim">
          <span>Project</span>
          <span>Go</span>
          <span>View</span>
          <span>Help</span>
        </div>
      )}

      {/* The island */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <Island
          state={state}
          dispatch={dispatch}
          holdNews={holdNews}
          compact={compact}
        />
      </div>

      <div className="ml-auto flex items-center gap-4 text-faint">
        <Minus size={13} />
        <Square size={11} />
        <X size={13} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function Sidebar({
  state,
  dispatch,
}: {
  state: DemoState;
  dispatch: Dispatch<Action>;
}) {
  // Decks only appear once a project has two; with one, its terminals sit
  // straight under the project, exactly as the app does it.
  const showDecks = state.decks.length > 1;
  const focusedPane = state.panes.find((p) => p.id === state.focused);
  // Exactly one row is filled: the focused terminal, else the active deck.
  const leaf: "pane" | "deck" =
    focusedPane && focusedPane.deck === state.deck ? "pane" : "deck";

  return (
    <div className="sheen flex w-[236px] shrink-0 flex-col rounded-[12px] bg-chrome p-2 text-[13px]">
      <div className="flex h-8 items-center gap-2 px-2">
        <span className="font-medium text-ink">Projects</span>
        <span className="rounded-[5px] bg-white/[0.07] px-1.5 text-[10px] leading-4 text-dim">
          2
        </span>
        <button
          type="button"
          aria-label="Add terminals"
          onClick={() => dispatch({ type: "overlay", overlay: "launch" })}
          className="ml-auto grid size-6 place-items-center rounded-[6px] text-dim hover:bg-veil-2 hover:text-ink"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="term-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        <div className="mt-1 flex h-8 items-center gap-1.5 rounded-[8px] px-2 text-ink">
          <ChevronDown size={13} className="text-faint" />
          <span className="font-medium">keel</span>
          <span className="ml-auto text-[11px] text-faint">{state.panes.length}</span>
        </div>

        {showDecks ? (
          <div className="relative flex flex-col gap-px">
            <Guide left={14} />
            {state.decks.map((deck, i) => (
              <DeckGroup
                key={deck.id}
                deck={deck}
                index={i}
                state={state}
                dispatch={dispatch}
                filled={deck.id === state.deck && leaf === "deck"}
              />
            ))}
          </div>
        ) : (
          <div className="relative flex flex-col gap-px">
            <Guide left={14} />
            {state.panes.map((p) => (
              <PaneRow
                key={p.id}
                pane={p}
                state={state}
                depth={1}
                onClick={() => dispatch({ type: "focus", paneId: p.id })}
              />
            ))}
          </div>
        )}

        <div className="mt-2 flex h-8 items-center gap-1.5 rounded-[8px] px-2 text-dim">
          <ChevronRight size={13} className="text-faint" />
          <span>atlas-api</span>
          <span className="ml-auto flex items-center gap-1.5">
            <StatusDot status="idle" />
            <span className="text-[11px] text-faint">2</span>
          </span>
        </div>
      </div>

      <div className="rounded-[8px] px-2 pt-2 pb-1 text-[11px] leading-[1.45] text-faint">
        Amber is working. Green finished while you were somewhere else.
      </div>
    </div>
  );
}

/** The hairline that says "these rows belong to the one above". */
function Guide({ left }: { left: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute top-0 bottom-1 w-px bg-white/[0.07]"
      style={{ left }}
    />
  );
}

function DeckGroup({
  deck,
  index,
  state,
  dispatch,
  filled,
}: {
  deck: DemoState["decks"][number];
  index: number;
  state: DemoState;
  dispatch: Dispatch<Action>;
  filled: boolean;
}) {
  const panes = state.panes.filter((p) => p.deck === deck.id);
  const active = deck.id === state.deck;
  const attention = panes.some((p) => p.status === "done")
    ? "done"
    : panes.some((p) => p.status === "working")
      ? "working"
      : null;

  return (
    <div className="flex flex-col gap-px">
      <button
        type="button"
        onClick={() => dispatch({ type: "deck", deck: deck.id })}
        title={`${deck.name} (Ctrl+${index + 1})`}
        className={`flex h-8 w-full items-center gap-2 rounded-[8px] pr-2 pl-6 text-left transition-colors ${
          filled
            ? "bg-white/[0.09] text-ink"
            : active
              ? "text-ink hover:bg-veil"
              : "text-dim hover:bg-veil hover:text-ink"
        }`}
      >
        <Grid2x2 size={12} className={active ? "text-dim" : "text-faint"} />
        <span className="min-w-0 flex-1 truncate">{deck.name}</span>
        {attention && <StatusDot status={attention} />}
        <span className="w-3 text-right text-[11px] text-faint tabular-nums">{panes.length}</span>
      </button>
      <div className="relative flex flex-col gap-px">
        {panes.length > 0 && <Guide left={30} />}
        {panes.map((p) => (
          <PaneRow
            key={p.id}
            pane={p}
            state={state}
            depth={2}
            onClick={() => dispatch({ type: "focus", paneId: p.id })}
          />
        ))}
        {panes.length === 0 && (
          <button
            type="button"
            onClick={() => {
              dispatch({ type: "deck", deck: deck.id });
              dispatch({ type: "overlay", overlay: "launch" });
            }}
            className="flex h-8 w-full items-center gap-2 rounded-[8px] pr-2 pl-10 text-left text-faint hover:bg-veil hover:text-ink"
          >
            <Plus size={12} />
            Add terminals
          </button>
        )}
      </div>
    </div>
  );
}

function PaneRow({
  pane,
  state,
  depth,
  onClick,
}: {
  pane: Pane;
  state: DemoState;
  depth: 1 | 2;
  onClick: () => void;
}) {
  const filled = state.focused === pane.id && pane.deck === state.deck;
  const secs = Math.floor((state.now - pane.startedAt) / 1000);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex h-8 w-full items-center gap-2 rounded-[8px] pr-2 text-left transition-colors ${
        depth === 2 ? "pl-10" : "pl-6"
      } ${filled ? "bg-white/[0.09] text-ink" : "text-dim hover:bg-veil hover:text-ink"}`}
    >
      <StatusDot status={pane.status} />
      <AgentMark agent={pane.agent} size={16} />
      <span className="min-w-0 flex-1 truncate">
        {pane.agent === "shell" ? "Shell" : pane.title === "New session" ? AGENTS[pane.agent].name : pane.title}
      </span>
      {pane.status === "working" && (
        <span className="shrink-0 text-[10px] text-faint tabular-nums">{since(secs)}</span>
      )}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* The island                                                                  */
/* -------------------------------------------------------------------------- */

/*
 * The width is animated from a measured size rather than with a layout
 * animation. Layout animations measure on screen, and the demo sits inside a
 * scroll-driven tilt: every re-render saw a slightly different box and started
 * a new correction, which read as a flicker.
 */
function Island({
  state,
  dispatch,
  holdNews,
  compact,
}: {
  state: DemoState;
  dispatch: Dispatch<Action>;
  holdNews: (hold: boolean) => void;
  compact: boolean;
}) {
  const waiting = state.panes.filter((p) => p.status === "done").length;
  const newsPane = state.news
    ? state.panes.find((p) => p.id === state.news!.paneId)
    : undefined;
  const deck = state.decks.find((d) => d.id === state.deck);
  const deckName = state.decks.length > 1 ? deck?.name : undefined;

  const sizer = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = sizer.current;
    if (!el) return;
    const measure = () => setWidth(el.offsetWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const body = newsPane ? (
    <>
      <AgentMark agent={newsPane.agent} size={16} />
      <span className="font-medium">{AGENTS[newsPane.agent].name} finished</span>
      {!compact && <span className="text-faint">{newsPane.title}</span>}
      <span className="ml-1 rounded-[4px] bg-white/10 px-1.5 text-[10px] leading-[16px] text-dim">
        F8
      </span>
    </>
  ) : (
    <>
      <span className="text-dim">keel</span>
      {deckName && <span className="text-faint">{deckName}</span>}
      {waiting > 0 && (
        <span className="flex items-center gap-1.5 text-[11px] text-dim">
          <StatusDot status="done" />
          {waiting} waiting
        </span>
      )}
    </>
  );
  const key = newsPane ? `news-${newsPane.id}` : "rest";

  return (
    <motion.button
      type="button"
      initial={false}
      animate={width === null ? undefined : { width: width + 24 }}
      transition={{ type: "spring", stiffness: 420, damping: 36 }}
      onPointerEnter={() => holdNews(true)}
      onPointerLeave={() => holdNews(false)}
      onClick={() =>
        newsPane
          ? dispatch({ type: "focus", paneId: newsPane.id })
          : waiting
            ? dispatch({ type: "next-waiting" })
            : dispatch({ type: "overlay", overlay: "overview" })
      }
      className="relative grid h-[26px] place-items-center overflow-hidden rounded-full bg-[#1f1f1f] text-[12px] text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_1px_rgba(255,255,255,0.05)]"
    >
      {/* Measures what the island is about to say; never seen. */}
      <span
        ref={sizer}
        aria-hidden
        className="invisible absolute top-0 left-0 flex items-center gap-2 whitespace-nowrap"
      >
        {body}
      </span>
      <AnimatePresence initial={false}>
        <motion.span
          key={key}
          initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
          transition={{ duration: 0.26 }}
          className="flex items-center gap-2 whitespace-nowrap [grid-area:1/1]"
        >
          {body}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

/* -------------------------------------------------------------------------- */

export function Rail() {
  return (
    <div className="sheen flex w-10 shrink-0 flex-col items-center gap-1 rounded-[12px] bg-chrome py-2 text-faint">
      <div className="grid size-7 place-items-center rounded-[7px] bg-white/[0.07] text-ink">
        <FileText size={14} />
      </div>
      <div className="relative grid size-7 place-items-center rounded-[7px]">
        <GitBranch size={14} />
        <span className="absolute -top-0.5 -right-0.5 grid size-3.5 place-items-center rounded-full bg-[#2a2a2a] text-[8px] text-ink">
          3
        </span>
      </div>
      <div className="grid size-7 place-items-center rounded-[7px]">
        <Search size={14} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Ring({ value, agent }: { value: number; agent: "claude" | "codex" }) {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const tone = value >= 90 ? "var(--k-dead)" : value >= 75 ? "var(--k-working)" : "#bdbdbd";
  return (
    <span className="flex items-center gap-1.5">
      <span className="relative grid size-4 place-items-center">
        <svg viewBox="0 0 16 16" className="absolute inset-0 -rotate-90">
          <circle cx="8" cy="8" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1.6" />
          <motion.circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            stroke={tone}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeDasharray={c}
            initial={false}
            animate={{ strokeDashoffset: c * (1 - value / 100) }}
            transition={{ duration: 0.8 }}
          />
        </svg>
        <AgentMark agent={agent} size={8} variant="glyph" />
      </span>
      <span className="tabular-nums" style={{ color: value >= 75 ? tone : undefined }}>
        {value}%
      </span>
    </span>
  );
}

export function StatusBar({
  state,
  dispatch,
  sound,
  setSound,
}: {
  state: DemoState;
  dispatch: Dispatch<Action>;
  sound: boolean;
  setSound: (on: boolean) => void;
}) {
  const focused = state.panes.find((p) => p.id === state.focused);
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 px-2 text-[11px] text-faint">
      <button
        type="button"
        aria-label="Deck overview"
        onClick={() =>
          dispatch({
            type: "overlay",
            overlay: state.overlay === "overview" ? null : "overview",
          })
        }
        className={`grid size-5 place-items-center rounded-[5px] hover:bg-veil-2 hover:text-ink ${state.overlay === "overview" ? "bg-veil-3 text-ink" : ""}`}
      >
        <Grid2x2 size={12} />
      </button>
      <div className="flex items-center gap-px rounded-[6px] bg-black/50 p-[2px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)]">
        {state.decks.map((d, i) => {
          const busy = state.panes.some((p) => p.deck === d.id && p.status === "working");
          const waiting = state.panes.some((p) => p.deck === d.id && p.status === "done");
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => dispatch({ type: "deck", deck: d.id })}
              aria-label={`Switch to ${d.name}`}
              className={`relative grid h-[18px] min-w-[20px] place-items-center rounded-[4px] px-1 tabular-nums ${
                d.id === state.deck ? "bg-white/[0.12] text-ink" : "hover:text-ink"
              }`}
            >
              {i + 1}
              {(busy || waiting) && d.id !== state.deck && (
                <span
                  className="absolute top-[2px] right-[2px] size-[4px] rounded-full"
                  style={{ background: waiting ? "var(--k-done)" : "var(--k-working)" }}
                />
              )}
            </button>
          );
        })}
        <button
          type="button"
          aria-label="New deck"
          onClick={() => dispatch({ type: "add-deck" })}
          className="grid h-[18px] w-[18px] place-items-center rounded-[4px] hover:text-ink"
        >
          <Plus size={10} />
        </button>
      </div>
      <span className="truncate pl-1">{focused?.cwd ?? "~/code/keel"}</span>

      <div className="ml-auto flex items-center gap-3.5">
        <button
          type="button"
          onClick={() => setSound(!sound)}
          className="flex items-center gap-1.5 hover:text-ink"
          aria-pressed={sound}
        >
          {sound ? <Bell size={11} /> : <BellOff size={11} />}
          {sound ? "Chime on" : "Chime off"}
        </button>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-done" />
          VPN
        </span>
        <Ring value={state.usage.claude} agent="claude" />
        <Ring value={state.usage.codex} agent="codex" />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function Schematic({
  panes,
  newAgents = [],
  className = "",
}: {
  panes: Pane[];
  newAgents?: Pane["agent"][];
  className?: string;
}) {
  const all = [
    ...panes.map((p) => ({ agent: p.agent, status: p.status, fresh: false })),
    ...newAgents.map((a) => ({ agent: a, status: "idle" as const, fresh: true })),
  ];
  const rects = gridRects(all.length, 100, 100, 3);
  return (
    <div className={`relative ${className}`}>
      {all.map((p, i) => {
        const r = rects[i]!;
        const accent = AGENTS[p.agent].accent;
        return (
          <motion.div
            key={i}
            initial={false}
            animate={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            className="absolute flex items-start gap-1 rounded-[4px] p-1"
            style={{
              background: p.fresh
                ? `color-mix(in srgb, ${accent} 26%, #1b1b1b)`
                : "rgba(255,255,255,0.07)",
              boxShadow: p.fresh
                ? `inset 0 0 0 1px color-mix(in srgb, ${accent} 50%, transparent)`
                : "inset 0 0 0 1px rgba(255,255,255,0.05)",
            }}
          >
            <AgentMark agent={p.agent} size={10} variant="glyph" />
            {!p.fresh && p.status !== "idle" && <StatusDot status={p.status} size={4} />}
          </motion.div>
        );
      })}
    </div>
  );
}
