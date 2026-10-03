"use client";

import { AnimatePresence, MotionConfig, motion, useInView } from "motion/react";
import { Lock } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

import {
  AGENTS,
  AGENT_ORDER,
  AgentMark,
  KeelMark,
  StatusDot,
  gridRects,
  type AgentId,
  type PaneStatus,
} from "./marks";
import { Container, Heading } from "./ui";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Ticks while `ref` is on screen; the illustrations rest when you cannot see them. */
function useTicker(ms: number) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.5 });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!inView) return;
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [inView, ms]);
  return { ref, tick, inView };
}

/* ---- Decks keep running ------------------------------------------------- */

const DECKS = ["api", "web", "infra"];
const DECK_START: AgentId[][] = [
  ["claude", "codex", "gemini"],
  ["opencode", "aider"],
  ["goose", "crush", "pi", "grok"],
];
const PANE_STATUS: Partial<Record<AgentId, PaneStatus>> = {
  claude: "working",
  gemini: "working",
  codex: "done",
  goose: "working",
  pi: "done",
  crush: "working",
};

/** Three decks, all live, and every so often a running pane moves between them. */
function DecksVisual() {
  const { ref, tick } = useTicker(2600);
  const [decks, setDecks] = useState(DECK_START);

  useEffect(() => {
    if (tick === 0) return;
    setDecks((d) => {
      const from = (tick - 1) % d.length;
      const to = (from + 1) % d.length;
      if (d[from]!.length <= 1) return d;
      const next = d.map((x) => [...x]);
      next[to]!.push(next[from]!.pop()!);
      return next;
    });
  }, [tick]);

  return (
    <div ref={ref} className="flex h-full items-center gap-2.5 px-5 sm:gap-3 sm:px-7">
      {decks.map((panes, i) => {
        const rects = gridRects(panes.length, 100, 100, 3);
        const busy = panes.some((a) => PANE_STATUS[a] === "working");
        return (
          <div
            key={DECKS[i]}
            className="flex-1 rounded-[11px] bg-void p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_0_0_1px_rgba(255,255,255,0.06)] transition-transform duration-500 ease-keel group-hover:-translate-y-0.5"
          >
            <div className="mb-2 flex items-center gap-1.5 px-0.5 text-[11px] text-faint">
              <span className="text-dim tabular-nums">{i + 1}</span>
              <span className="truncate">{DECKS[i]}</span>
              {busy && <span className="ml-auto"><StatusDot status="working" size={5} /></span>}
            </div>
            <div className="relative aspect-[16/11]">
              {panes.map((agent, j) => {
                const r = rects[j]!;
                const status = PANE_STATUS[agent] ?? "idle";
                return (
                  <motion.div
                    key={agent}
                    layoutId={`feature-deck-${agent}`}
                    transition={{ type: "spring", stiffness: 240, damping: 30 }}
                    className="absolute flex flex-col gap-1 overflow-hidden rounded-[5px] bg-slab p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_0_1px_rgba(255,255,255,0.05)]"
                    style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
                  >
                    <span className="flex items-center gap-1">
                      <AgentMark agent={agent} size={10} />
                      <span className="ml-auto">
                        <StatusDot status={status} size={4} />
                      </span>
                    </span>
                    <span className="h-[3px] w-3/4 rounded-full bg-white/[0.07]" />
                    <span className="h-[3px] w-1/2 rounded-full bg-white/[0.05]" />
                  </motion.div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---- It comes back as you left it --------------------------------------- */

const RESUMED: [AgentId, string][] = [
  ["claude", "7f3a2c1e"],
  ["codex", "01be9d44"],
  ["gemini", "c44e10b2"],
];

function RestoreVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const line = (i: number) => ({
    initial: { opacity: 0, x: -6 },
    animate: inView ? { opacity: 1, x: 0 } : undefined,
    transition: { duration: 0.5, ease: EASE, delay: 0.2 + i * 0.32 },
  });
  return (
    <div ref={ref} className="flex h-full items-center px-5 sm:px-7">
      <div className="w-full rounded-[11px] bg-slab px-4 py-3.5 font-mono text-[12px] leading-[1.9] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_0_0_1px_rgba(255,255,255,0.06)]">
        <motion.div {...line(0)} className="text-faint">
          restoring 3 decks, 9 terminals
        </motion.div>
        {RESUMED.map(([agent, id], i) => (
          <motion.div key={agent} {...line(i + 1)} className="flex items-center gap-2 whitespace-nowrap">
            <span className="text-done">✓</span>
            <AgentMark agent={agent} size={12} variant="glyph" />
            <span className="w-[7.5em] truncate text-ink">{AGENTS[agent].name}</span>
            <span className="text-faint">↺</span>
            <span className="truncate text-dim">{id}</span>
          </motion.div>
        ))}
        <motion.div {...line(4)} className="flex items-center gap-1 text-faint">
          <span>❯</span>
          <span className="caret inline-block h-[13px] w-[7px] bg-ink/80" />
        </motion.div>
      </div>
    </div>
  );
}

/* ---- It knows when an agent is done ------------------------------------- */

function DoneVisual() {
  const { ref, tick } = useTicker(2400);
  const done = tick % 2 === 1;
  return (
    <div ref={ref} className="flex h-full flex-col items-center justify-center gap-6">
      <div className="relative grid size-20 place-items-center">
        {done &&
          [0, 1, 2].map((i) => (
            <motion.span
              key={`${tick}-${i}`}
              aria-hidden
              className="absolute size-4 rounded-full border border-done"
              initial={{ scale: 1, opacity: 0.8 }}
              animate={{ scale: 5.5, opacity: 0 }}
              transition={{ duration: 1.8, delay: i * 0.3, ease: "easeOut" }}
            />
          ))}
        <motion.span
          aria-hidden
          className={`relative size-4 rounded-full ${done ? "" : "pulse-dot"}`}
          animate={{
            backgroundColor: done ? "#4cc38a" : "#e9a23b",
            boxShadow: done ? "0 0 28px 4px rgba(76,195,138,0.55)" : "0 0 22px 2px rgba(233,162,59,0.4)",
            scale: done ? [1, 1.45, 1] : 1,
          }}
          transition={{ duration: 0.6, ease: EASE }}
        />
      </div>
      <div className="relative h-6 w-full">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={done ? "done" : "working"}
            initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
            transition={{ duration: 0.35, ease: EASE }}
            className="absolute inset-0 flex items-center justify-center gap-2 text-[13px]"
          >
            <AgentMark agent="claude" size={16} />
            {done ? (
              <>
                <span className="text-ink">Done</span>
                <span className="text-faint">·</span>
                <kbd className="rounded-[5px] bg-[linear-gradient(#262626,#1a1a1a)] px-1.5 py-px font-sans text-[12px] text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_1px_0_0_#050505]">
                  F8
                </kbd>
                <span className="text-dim">takes you there</span>
              </>
            ) : (
              <>
                <span className="text-ink">Claude Code</span>
                <span className="text-faint">·</span>
                <span className="text-dim">working</span>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ---- Editor, search and Git in reach ------------------------------------ */

const DIFF: [" " | "+" | "-", string][] = [
  [" ", "export function rows(n: number) {"],
  ["-", "  const cols = n;"],
  ["+", "  const cols = Math.ceil(Math.sqrt(n));"],
  ["+", "  // rows differ by one, at most"],
  [" ", "  return balance(n, cols);"],
];

function GitVisual() {
  return (
    <div className="flex h-full items-center px-5 sm:px-7">
      <div className="w-full overflow-hidden rounded-[11px] bg-slab shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_0_0_1px_rgba(255,255,255,0.06)]">
        <div className="flex h-8 items-center gap-2 px-3 text-[11px]">
          <span className="font-semibold text-working">M</span>
          <span className="text-dim">src/lib/layout.ts</span>
          <span className="ml-auto rounded-[5px] px-1.5 py-0.5 text-faint shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] transition-colors duration-300 group-hover:bg-ink group-hover:text-black">
            Stage hunk
          </span>
        </div>
        <div className="pb-2 font-mono text-[11.5px] leading-[1.75]">
          {DIFF.map(([sign, code], i) => (
            <div
              key={i}
              className="flex gap-2.5 px-3 whitespace-pre"
              style={{
                background:
                  sign === "+" ? "rgba(76,195,138,0.1)" : sign === "-" ? "rgba(236,93,94,0.1)" : undefined,
              }}
            >
              <span
                className="w-2 select-none"
                style={{ color: sign === "+" ? "var(--k-done)" : sign === "-" ? "var(--k-dead)" : "var(--k-faint)" }}
              >
                {sign}
              </span>
              <span className={`truncate ${sign === " " ? "text-faint" : "text-ink/90"}`}>{code}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---- Quota where you can see it ----------------------------------------- */

const QUOTA: [AgentId, number][] = [
  ["claude", 42],
  ["codex", 78],
  ["gemini", 93],
];

function QuotaVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div ref={ref} className="flex h-full items-center justify-center gap-6 sm:gap-8">
      {QUOTA.map(([agent, value], i) => {
        const tone = value >= 90 ? "var(--k-dead)" : value >= 75 ? "var(--k-working)" : "#bdbdbd";
        return (
          <div key={agent} className="flex flex-col items-center gap-3">
            <div className="relative grid size-16 place-items-center">
              <svg viewBox="0 0 64 64" className="absolute inset-0 -rotate-90">
                <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
                <motion.circle
                  cx="32"
                  cy="32"
                  r={r}
                  fill="none"
                  stroke={tone}
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={c}
                  initial={{ strokeDashoffset: c }}
                  animate={inView ? { strokeDashoffset: c * (1 - value / 100) } : undefined}
                  transition={{ duration: 1.4, ease: EASE, delay: 0.15 + i * 0.15 }}
                />
              </svg>
              <AgentMark agent={agent} size={20} variant="glyph" />
            </div>
            <span
              className="text-[14px] font-semibold tabular-nums"
              style={{ color: value >= 75 ? tone : "var(--k-dim)" }}
            >
              {value}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ---- It steps back when you do ------------------------------------------ */

function FadeVisual() {
  const { ref, tick } = useTicker(2600);
  const away = tick % 2 === 1;
  return (
    <div ref={ref} className="relative h-full overflow-hidden">
      {/* Whatever you switched to, behind the window. */}
      <div aria-hidden className="absolute top-8 right-6 left-16 h-28 rounded-[9px] bg-[#1d1d1d] p-3">
        <div className="mb-2 h-1.5 w-1/3 rounded-full bg-white/20" />
        <div className="mb-1.5 h-1 w-3/4 rounded-full bg-white/10" />
        <div className="mb-1.5 h-1 w-2/3 rounded-full bg-white/10" />
        <div className="h-1 w-1/2 rounded-full bg-white/10" />
      </div>
      <motion.div
        aria-hidden
        className="absolute top-12 left-6 h-32 w-[62%] rounded-[10px] bg-chrome p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_0_0_1px_rgba(255,255,255,0.08),0_20px_40px_-12px_rgba(0,0,0,0.9)]"
        animate={{ opacity: away ? 0.6 : 1 }}
        transition={{ duration: 0.9, ease: EASE }}
      >
        <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[9px] text-faint">
          <KeelMark size={9} />
          keel
        </div>
        <div className="grid h-[calc(100%-18px)] grid-cols-2 gap-1">
          {(["claude", "codex", "gemini", "opencode"] as const).map((a) => (
            <div key={a} className="rounded-[4px] bg-slab p-1">
              <AgentMark agent={a} size={10} />
            </div>
          ))}
        </div>
      </motion.div>
      <motion.svg
        aria-hidden
        width="14"
        height="18"
        viewBox="0 0 14 18"
        className="absolute top-0 left-0 drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]"
        animate={away ? { x: 300, y: 110 } : { x: 120, y: 100 }}
        transition={{ duration: 0.9, ease: EASE }}
      >
        <path d="M1 1v13.5l3.6-3.3 2.3 5.3 2.4-1-2.3-5.2H12z" fill="#fff" stroke="#000" strokeWidth="1" strokeLinejoin="round" />
      </motion.svg>
      <span className="absolute top-4 left-6 rounded-full px-2 py-0.5 text-[11px] text-dim shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]">
        {away ? "Out of focus" : "Focused"}
      </span>
    </div>
  );
}

/* ---- Your CLIs, your accounts ------------------------------------------- */

function CliVisual() {
  return (
    <div className="flex h-full items-center justify-center px-5">
      <div className="grid grid-cols-5 gap-2.5">
        {AGENT_ORDER.map((agent, i) => (
          <motion.span
            key={agent}
            title={AGENTS[agent].name}
            initial={{ opacity: 0, scale: 0.6, y: 10 }}
            whileInView={{ opacity: 1, scale: 1, y: 0 }}
            viewport={{ once: true, amount: 0.8 }}
            whileHover={{ y: -4, scale: 1.08 }}
            transition={{ type: "spring", stiffness: 320, damping: 20, delay: i * 0.04 }}
            className="block"
          >
            <AgentMark agent={agent} size={38} />
          </motion.span>
        ))}
      </div>
    </div>
  );
}

/* ---- A private tunnel on Windows ---------------------------------------- */

function Flow({ live, dashed = false }: { live?: boolean; dashed?: boolean }) {
  return (
    <motion.span
      aria-hidden
      className="h-px flex-1"
      style={{
        backgroundImage: dashed
          ? "repeating-linear-gradient(90deg, rgba(255,255,255,0.18) 0 4px, transparent 4px 9px)"
          : "repeating-linear-gradient(90deg, rgba(76,195,138,0.9) 0 10px, rgba(76,195,138,0.15) 10px 18px)",
      }}
      animate={live ? { backgroundPositionX: ["0px", "18px"] } : undefined}
      transition={live ? { duration: 0.9, ease: "linear", repeat: Infinity } : undefined}
    />
  );
}

function TunnelVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const node = "flex shrink-0 items-center gap-2 rounded-[9px] bg-void px-2.5 py-1.5 text-[12px] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_0_0_1px_rgba(255,255,255,0.07)]";
  return (
    <div ref={ref} className="relative flex h-full flex-col justify-center gap-7 px-5 sm:px-7">
      <span className="absolute top-4 right-5 rounded-full px-2 py-0.5 text-[11px] text-faint shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] sm:right-7">
        Windows
      </span>
      <div className="flex items-center gap-2">
        <span className={`${node} text-ink`}>
          <KeelMark size={13} />
          Keel
        </span>
        <Flow live={inView} />
        <span className={`${node} text-ink`}>
          <Lock size={12} className="text-done" />
          OpenVPN
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`${node} text-dim`}>Everything else</span>
        <Flow dashed />
        <span className={`${node} text-dim`}>Default route</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

const FEATURES: { title: string; body: string; span: string; visual: ReactNode }[] = [
  {
    title: "Decks keep running",
    body: "Split a project into decks of panes. Switch away and every process keeps going. The overview shows all of them at once and lets you move a running terminal to another deck.",
    span: "md:col-span-2 lg:col-span-4",
    visual: <DecksVisual />,
  },
  {
    title: "It comes back as you left it",
    body: "Projects, layouts, terminals and resumable agent conversations return after a restart. Keel saves each conversation's real ID the moment the agent reports it, and resumes that one.",
    span: "lg:col-span-2",
    visual: <RestoreVisual />,
  },
  {
    title: "It knows when an agent is done",
    body: "Lifecycle hooks report when a turn starts and ends. A finished agent chimes unless its own pane has focus, even from another deck, project or dialog. Mute notifications per pane.",
    span: "lg:col-span-2",
    visual: <DoneVisual />,
  },
  {
    title: "Editor, search and Git in reach",
    body: "Open files in the built-in editor, search the whole project, and review diffs. Stage, commit, fetch, pull, push and switch branches without leaving the deck.",
    span: "lg:col-span-2",
    visual: <GitVisual />,
  },
  {
    title: "Quota where you can see it",
    body: "Subscription usage for each signed-in agent sits in the status bar: a small ring per login, amber from 75% and red from 90%.",
    span: "lg:col-span-2",
    visual: <QuotaVisual />,
  },
  {
    title: "It steps back when you do",
    body: "The window fades while it is out of focus, enough to see what is behind it, never so much that running agents become unreadable. Click into the demo above, then move off it.",
    span: "lg:col-span-2",
    visual: <FadeVisual />,
  },
  {
    title: "Your CLIs, your accounts",
    body: "Keel launches the agent CLIs already installed on your machine. No hosted service sits in between, and nothing about your credentials leaves the tools that manage them.",
    span: "lg:col-span-2",
    visual: <CliVisual />,
  },
  {
    title: "A private tunnel on Windows",
    body: "Optionally route Keel's traffic through an isolated OpenVPN tunnel without replacing your machine's default route.",
    span: "md:col-span-2 lg:col-span-2",
    visual: <TunnelVisual />,
  },
];

/** Light the card from wherever the pointer is; see `.spotlight` in globals.css. */
function track(e: PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--x", `${e.clientX - r.left}px`);
  el.style.setProperty("--y", `${e.clientY - r.top}px`);
}

export function Features() {
  return (
    <MotionConfig reducedMotion="user">
      <section id="features" className="relative py-24 sm:py-36">
        <Container>
          <div className="grid gap-10 md:grid-cols-12">
            <Heading className="md:col-span-7">Built for a long day of parallel work.</Heading>
            <p className="max-w-[30rem] text-[18px] leading-[1.65] text-dim md:col-span-5 md:self-end">
              A native app built on Tauri and Rust, so a dozen terminals cost
              what terminals cost.
            </p>
          </div>

          <ul className="mt-16 grid gap-3 md:grid-cols-2 lg:mt-24 lg:grid-cols-6">
            {FEATURES.map((f, i) => (
              <motion.li
                key={f.title}
                initial={{ opacity: 0, y: 28 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.2 }}
                transition={{ duration: 0.8, ease: EASE, delay: (i % 3) * 0.08 }}
                onPointerMove={track}
                className={`spotlight group relative flex flex-col overflow-hidden rounded-[18px] bg-[linear-gradient(180deg,#101010,#0a0a0a)] shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_0_0_1px_rgba(255,255,255,0.06)] ${f.span}`}
              >
                <div className="relative h-[210px] shrink-0 overflow-hidden">{f.visual}</div>
                <div className="relative mt-auto px-6 pt-2 pb-7 sm:px-7">
                  <h3 className="text-[20px] leading-[1.2] font-[700] tracking-[-0.015em] [font-stretch:108%]">
                    {f.title}
                  </h3>
                  <p className="mt-2.5 text-[15px] leading-[1.6] text-dim transition-colors duration-300 group-hover:text-ink/85">
                    {f.body}
                  </p>
                </div>
              </motion.li>
            ))}
          </ul>
        </Container>
      </section>
    </MotionConfig>
  );
}
