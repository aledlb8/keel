"use client";

import { AnimatePresence, MotionConfig, motion, useInView, useReducedMotion } from "motion/react";
import { ChevronDown, LayoutList, Monitor, PictureInPicture2, Pin, Repeat } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { AgentMark, KeelMark, StatusDot, gridRects, type AgentId, type PaneStatus } from "./marks";
import { Container, Heading } from "./ui";

const EASE = [0.22, 1, 0.36, 1] as const;

/*
 * One scripted arrangement, a step every STEP_MS:
 *   Keel on the middle monitor with two decks. Deck 2 goes to the right-hand
 *   monitor in a window of its own, still running, and the main window moves
 *   to Deck 1. A pane pops out of Deck 1 into a small window kept on top in
 *   the corner, and the agent board sits on the left-hand monitor.
 */
const STEP_MS = 1300;
const STEPS = 10;
const SENT = 2;
const POPPED = 4;
const BOARD = 6;
const FINAL = 8;

const POINTS: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <Monitor size={16} />,
    title: "A deck to a monitor",
    body: "Open any deck in a window of its own, or send it to the monitor on the left or right with a key. The main window moves on to another deck.",
  },
  {
    icon: <Repeat size={16} />,
    title: "Nothing restarts",
    body: "Keel keeps every terminal's screen and scrollback itself, so a deck moves between windows, or off screen, with its agents still running.",
  },
  {
    icon: <PictureInPicture2 size={16} />,
    title: "Pop out and the board",
    body: "Pop one pane into a small window kept above the rest, or open the agent board: everything waiting on you, working or idle, across every window.",
  },
  {
    icon: <Pin size={16} />,
    title: "Docks and undocks",
    body: "Windows come back where they were on each set of monitors. Unplug the laptop and they fold back into the main window; dock it and they return.",
  },
];

/** A pane drawn small: its agent, a title, a status dot and a few lines. */
function MiniPane({ agent, title, status }: { agent: AgentId; title: string; status: PaneStatus }) {
  return (
    <div className="flex h-full flex-col gap-1 rounded-[5px] bg-slab p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_0_1px_rgba(255,255,255,0.05)]">
      <span className="flex h-3.5 items-center gap-1 text-[8.5px] text-dim">
        <AgentMark agent={agent} size={10} />
        <span className="truncate">{title}</span>
        <span className="ml-auto">
          <StatusDot status={status} size={4} />
        </span>
      </span>
      <span className="h-[2px] w-3/4 rounded-full bg-white/[0.07]" />
      <span className="h-[2px] w-1/2 rounded-full bg-white/[0.05]" />
      <span className="h-[2px] w-2/3 rounded-full bg-white/[0.05]" />
    </div>
  );
}

const DECK_ONE: [AgentId, string, PaneStatus][] = [
  ["claude", "Login flow", "working"],
  ["codex", "Usage tests", "done"],
  ["shell", "Shell", "idle"],
];
/** The pane that pops out of Deck 1. */
const POPPED_PANE = "Usage tests";
const DECK_TWO: [AgentId, string, PaneStatus][] = [
  ["opencode", "Docs pass", "working"],
  ["grok", "Refactor store", "working"],
];

function Panes({ panes }: { panes: [AgentId, string, PaneStatus][] }) {
  const rects = gridRects(panes.length, 100, 100, 3);
  return (
    <div className="relative h-full w-full">
      {panes.map(([agent, title, status], i) => {
        const r = rects[i]!;
        return (
          <motion.div
            key={title}
            layout
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 30 }}
            className="absolute"
            style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
          >
            <MiniPane agent={agent} title={title} status={status} />
          </motion.div>
        );
      })}
    </div>
  );
}

/** A monitor on its stand. */
function Display({ children, label }: { children?: ReactNode; label: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
      <div className="relative aspect-[16/10] w-full rounded-[10px] bg-ground p-1.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),0_24px_60px_-30px_rgba(0,0,0,1)]">
        <div className="relative h-full w-full overflow-hidden rounded-[6px] bg-[radial-gradient(120%_90%_at_50%_0%,#151515,#090909)]">
          {children}
        </div>
      </div>
      <span className="h-3 w-px bg-white/10" />
      <span className="text-[11px] text-faint">{label}</span>
    </div>
  );
}

/** Keel's main window: the slim bar with the deck it shows, and its panes. */
function MainWindow({ step }: { step: number }) {
  const deck = step >= SENT ? "Deck 1" : "Deck 2";
  return (
    <div className="absolute inset-[6%] flex flex-col rounded-[6px] bg-chrome p-1 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
      <div className="mb-1 flex items-center gap-1.5 px-1 text-[8px] text-faint">
        <KeelMark size={8} />
        <span className="rounded-full bg-veil-2 px-1.5 text-dim">keel · {deck}</span>
      </div>
      <div className="relative min-h-0 flex-1 rounded-[4px] bg-void p-1">
        <Panes
          panes={
            step < SENT
              ? DECK_TWO
              : step < POPPED
                ? DECK_ONE
                : DECK_ONE.filter(([, title]) => title !== POPPED_PANE)
          }
        />
      </div>
    </div>
  );
}

/** A screen window: one deck filling the monitor, with its own slim bar. */
function ScreenWindow() {
  return (
    <motion.div
      key="screen"
      initial={{ opacity: 0, x: "-40%", scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.7, ease: EASE }}
      className="absolute inset-0 flex flex-col bg-chrome p-1"
    >
      <div className="mb-1 flex items-center gap-1 px-1 text-[8px] text-faint">
        <KeelMark size={8} />
        <span className="font-semibold text-ink">Deck 2</span>
        <span>keel</span>
        <ChevronDown size={8} />
        <Pin size={8} className="ml-auto" />
      </div>
      <div className="relative min-h-0 flex-1 rounded-[4px] bg-void p-1">
        <Panes panes={DECK_TWO} />
      </div>
    </motion.div>
  );
}

/** One pane popped out, kept above everything in a corner. */
function PopOut() {
  return (
    <motion.div
      key="pop"
      initial={{ opacity: 0, scale: 0.8, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
      className="absolute right-[5%] bottom-[6%] flex h-[42%] w-[46%] flex-col rounded-[5px] bg-chrome p-1 shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_12px_30px_-10px_rgba(0,0,0,1)]"
    >
      <div className="mb-0.5 flex items-center gap-1 px-0.5 text-[7.5px] text-faint">
        <span className="truncate text-ink">Usage tests</span>
        <Pin size={7} className="ml-auto text-ink" />
      </div>
      <div className="min-h-0 flex-1">
        <MiniPane agent="codex" title="Usage tests" status="done" />
      </div>
    </motion.div>
  );
}

const BOARD_ROWS: [string, [AgentId, string, PaneStatus][]][] = [
  ["Waiting on you", [["codex", "Usage tests", "done"]]],
  [
    "Working",
    [
      ["claude", "Login flow", "working"],
      ["opencode", "Docs pass", "working"],
      ["grok", "Refactor store", "working"],
    ],
  ],
];

/** The agent board: every agent in Keel, grouped by what needs you. */
function Board() {
  return (
    <motion.div
      key="board"
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
      className="absolute top-[6%] left-[5%] flex h-[84%] w-[40%] flex-col gap-1 rounded-[5px] bg-chrome p-1.5 shadow-[0_0_0_1px_rgba(255,255,255,0.1)]"
    >
      <span className="flex items-center gap-1 text-[7.5px] text-dim">
        <LayoutList size={8} />
        Agents
      </span>
      {BOARD_ROWS.map(([title, rows]) => (
        <span key={title} className="flex flex-col gap-0.5">
          <span className="text-[6px] tracking-[0.06em] text-faint uppercase">{title}</span>
          {rows.map(([agent, name, status]) => (
            <span key={name} className="flex items-center gap-1 text-[7px] text-dim">
              <StatusDot status={status} size={3.5} />
              <AgentMark agent={agent} size={8} />
              <span className="truncate">{name}</span>
            </span>
          ))}
        </span>
      ))}
    </motion.div>
  );
}

function Desk({ step }: { step: number }) {
  return (
    <div className="flex w-full max-w-[880px] items-end gap-3 sm:gap-5">
      <Display label="Left">
        <AnimatePresence>{step >= BOARD ? <Board /> : null}</AnimatePresence>
      </Display>
      <Display label="Main">
        <MainWindow step={step} />
        <AnimatePresence>{step >= POPPED ? <PopOut /> : null}</AnimatePresence>
      </Display>
      <Display label="Right">
        <AnimatePresence>{step >= SENT ? <ScreenWindow /> : null}</AnimatePresence>
      </Display>
    </div>
  );
}

export function Screens() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.35 });
  const reduce = useReducedMotion();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => setTick((t) => t + 1), STEP_MS);
    return () => clearInterval(id);
  }, [inView, reduce]);

  // Without motion, show the arrangement already made.
  const step = reduce ? FINAL : tick % STEPS;

  return (
    <MotionConfig reducedMotion="user">
      <section id="screens" className="relative py-24 sm:py-36">
        <Container>
          <div className="grid gap-10 md:grid-cols-12">
            <Heading className="md:col-span-7">One monitor or ten.</Heading>
            <p className="max-w-[30rem] text-[18px] leading-[1.65] text-dim md:col-span-5 md:self-end">
              Give a deck a window of its own and put it on any monitor. Every
              window shows Keel&apos;s one set of projects, and the agents in
              them keep running wherever their deck goes.
            </p>
          </div>

          <div ref={ref} className="mt-16 grid items-center gap-14 lg:mt-24 lg:grid-cols-12">
            <ul className="grid gap-8 sm:grid-cols-2 lg:col-span-4 lg:grid-cols-1">
              {POINTS.map((point, i) => (
                <motion.li
                  key={point.title}
                  initial={{ opacity: 0, y: 18 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.6 }}
                  transition={{ duration: 0.7, ease: EASE, delay: i * 0.08 }}
                  className="flex gap-4"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-raised text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_0_0_1px_rgba(255,255,255,0.06)]">
                    {point.icon}
                  </span>
                  <span>
                    <span className="block text-[17px] font-[700] tracking-[-0.01em]">{point.title}</span>
                    <span className="mt-1 block text-[15px] leading-[1.6] text-dim">{point.body}</span>
                  </span>
                </motion.li>
              ))}
            </ul>

            <div className="relative flex flex-col items-center gap-6 lg:col-span-8">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(50%_50%_at_50%_50%,rgba(255,255,255,0.06),transparent_100%)]"
              />
              <Desk step={step} />
              <span className="text-[13px] text-faint">
                Ctrl+Alt+Shift and an arrow sends the deck in front to the monitor that way.
              </span>
            </div>
          </div>
        </Container>
      </section>
    </MotionConfig>
  );
}
