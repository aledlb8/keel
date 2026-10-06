"use client";

import { AnimatePresence, MotionConfig, motion, useInView, useReducedMotion } from "motion/react";
import { ArrowLeftRight, Brain, Check, Forward, History, NotebookPen } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { AGENTS, AgentMark, KeelMark, StatusDot, gridRects, type AgentId, type PaneStatus } from "./marks";
import { Container, Heading } from "./ui";

const EASE = [0.22, 1, 0.36, 1] as const;

/*
 * One scripted handoff, a step every STEP_MS:
 *   Claude Code finishes and its header offers a handoff, the menu opens and
 *   Codex is picked, the conversation is written down and carried across,
 *   and Codex opens beside it and picks up where Claude stopped.
 */
const STEP_MS = 1100;
const STEPS = 15;
const DONE = 3;
const MENU = 4;
const PICK = 5;
const CARRY = 6;
const OPEN = 7;
const READ = 9;
const FINAL = 11;

const POINTS: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <History size={16} />,
    title: "The whole history",
    body: "Every message in order, through compactions and edited prompts, and every tool call with its result.",
  },
  {
    icon: <Brain size={16} />,
    title: "Its reasoning and memory",
    body: "The thinking the agent saved, its CLAUDE.md or AGENTS.md, what it remembers about you and the project, and the state of the repo.",
  },
  {
    icon: <NotebookPen size={16} />,
    title: "Notes for what's encrypted",
    body: "Providers keep some reasoning encrypted, so no file holds it. Ask the agent to write handoff notes first, and the next one reads them before anything else.",
  },
  {
    icon: <ArrowLeftRight size={16} />,
    title: "From any, to any",
    body: "Hand off from Claude Code, Codex, Grok Build or opencode to any agent you have installed, on any profile, or to a fresh chat of the same one.",
  },
];

const TARGETS: AgentId[] = ["codex", "grok", "opencode", "claude"];

/** What is carried across, shown as it lands. */
const CARRIED: [string, string][] = [
  ["12", "messages"],
  ["9", "reasoning passages"],
  ["64", "tool calls"],
  ["4", "memory files"],
];

function HeaderChip({ visible }: { visible: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.span
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.3, ease: EASE }}
          className="ml-auto flex h-5 items-center gap-1 rounded-[6px] px-1.5 text-[10.5px] text-ink"
          style={{
            background: "color-mix(in srgb, var(--k-done) 18%, transparent)",
            color: "color-mix(in srgb, var(--k-done) 70%, var(--k-text))",
          }}
        >
          <Forward size={11} />
          Hand off
        </motion.span>
      )}
    </AnimatePresence>
  );
}

function Menu({ step }: { step: number }) {
  return (
    <AnimatePresence>
      {step >= MENU && step < CARRY && (
        <motion.div
          key="menu"
          initial={{ opacity: 0, y: -6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
          transition={{ duration: 0.3, ease: EASE }}
          className="absolute top-8 right-2 z-10 w-[11.5rem] rounded-[9px] bg-raised p-1 text-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_0_0_1px_rgba(255,255,255,0.08),0_18px_40px_-12px_rgba(0,0,0,0.9)]"
        >
          <div className="px-2 pt-1 pb-1.5 text-[10px] text-faint">Hand off to</div>
          {TARGETS.map((agent) => {
            const picked = agent === "codex" && step >= PICK;
            return (
              <div
                key={agent}
                className={`flex items-center gap-2 rounded-[6px] px-2 py-1 transition-colors duration-200 ${
                  picked ? "bg-veil-3 text-ink" : "text-dim"
                }`}
              >
                <AgentMark agent={agent} size={12} variant="glyph" />
                <span className="truncate">
                  {AGENTS[agent].name}
                  {agent === "claude" ? " (new chat)" : ""}
                </span>
              </div>
            );
          })}
          <div className="my-1 h-px bg-line" />
          <div className="flex items-center gap-2 px-2 py-1 text-dim">
            <span className="grid size-3 place-items-center rounded-[3px] bg-ink text-black">
              <Check size={9} strokeWidth={3} />
            </span>
            <span className="truncate">Ask for notes first</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PaneLines({ agent, step }: { agent: AgentId; step: number }) {
  const spin = AGENTS[agent].spinner;
  if (agent === "claude") {
    return (
      <span className="block font-mono text-[10px] leading-[1.65] text-faint">
        <span className="block truncate text-ink/80">› add a handoff button to the header</span>
        {step < DONE ? (
          <span className="block" style={{ color: AGENTS.claude.accent }}>
            {spin[step % spin.length]} Wiring the header…
          </span>
        ) : step < CARRY ? (
          <span className="block text-done">✓ Header done; menu next.</span>
        ) : (
          <span className="block truncate text-dim">✎ Wrote NOTES.md for Codex</span>
        )}
      </span>
    );
  }
  return (
    <span className="block font-mono text-[10px] leading-[1.65] text-faint">
      <span className="block truncate text-ink/80">› read .keel/handoffs/…/HANDOFF.md</span>
      {step < READ ? (
        <span className="block" style={{ color: AGENTS.codex.accent }}>
          {spin[step % spin.length]} Reading the handoff…
        </span>
      ) : (
        <motion.span
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="block text-ink/85"
        >
          {AGENTS.codex.bullet} Picking up where Claude Code stopped: the menu.
        </motion.span>
      )}
    </span>
  );
}

/** A small Keel deck: Claude finishes, hands off, and Codex opens beside it. */
function HandoffDeck({ step }: { step: number }) {
  const opened = step >= OPEN;
  const claudeStatus: PaneStatus = step < DONE ? "working" : "done";
  const codexStatus: PaneStatus = step >= FINAL ? "done" : "working";
  const panes: [AgentId, PaneStatus][] = [
    ["claude", claudeStatus],
    ...(opened ? ([["codex", codexStatus]] as [AgentId, PaneStatus][]) : []),
  ];
  const rects = gridRects(panes.length, 100, 100, 2.4);

  return (
    <div className="w-full max-w-[560px] rounded-[14px] bg-chrome p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_0_0_1px_rgba(255,255,255,0.08),0_30px_70px_-30px_rgba(0,0,0,1)]">
      <div className="mb-2 flex items-center gap-2 px-1.5 pt-0.5 text-[11px] text-faint">
        <KeelMark size={11} />
        <span className="text-dim">keel</span>
      </div>
      <div className="relative aspect-[16/10] rounded-[10px] bg-void">
        {panes.map(([agent, status], i) => {
          const r = rects[i]!;
          return (
            <motion.div
              key={agent}
              layout
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 30 }}
              className="absolute flex flex-col gap-1.5 rounded-[7px] bg-slab p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_0_1px_rgba(255,255,255,0.05)]"
              style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
            >
              <span className="flex h-5 items-center gap-1.5 text-[10.5px] text-dim">
                <AgentMark agent={agent} size={13} />
                <span className="truncate">
                  {agent === "codex" ? "Handoff button · from Claude Code" : "Handoff button"}
                </span>
                {agent === "claude" ? (
                  <HeaderChip visible={step >= DONE && step < CARRY} />
                ) : null}
                <span className={agent === "claude" && step >= DONE && step < CARRY ? "" : "ml-auto"}>
                  <StatusDot status={status} size={5} />
                </span>
              </span>
              <PaneLines agent={agent} step={step} />
              <span className="mt-1 h-[3px] w-3/4 rounded-full bg-white/[0.06]" />
              <span className="h-[3px] w-1/2 rounded-full bg-white/[0.045]" />
              <span className="h-[3px] w-2/3 rounded-full bg-white/[0.045]" />
              {agent === "claude" ? <Menu step={step} /> : null}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

/** What went across, each count arriving in turn. */
function Carried({ step }: { step: number }) {
  return (
    <ul className="flex flex-wrap justify-center gap-2" aria-label="Carried across">
      {CARRIED.map(([count, what], i) => {
        const landed = step >= CARRY + Math.floor(i / 2);
        return (
          <motion.li
            key={what}
            initial={false}
            animate={{ opacity: landed ? 1 : 0.25, y: landed ? 0 : 4 }}
            transition={{ duration: 0.45, ease: EASE, delay: landed ? (i % 2) * 0.15 : 0 }}
            className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] text-dim shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
          >
            <span className="font-semibold text-ink tabular-nums">{count}</span>
            {what}
          </motion.li>
        );
      })}
    </ul>
  );
}

export function Handoff() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.35 });
  const reduce = useReducedMotion();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => setTick((t) => t + 1), STEP_MS);
    return () => clearInterval(id);
  }, [inView, reduce]);

  // Without motion, show the handoff already made.
  const step = reduce ? FINAL : tick % STEPS;

  return (
    <MotionConfig reducedMotion="user">
      <section id="handoff" className="relative py-24 sm:py-36">
        <Container>
          <div className="grid gap-10 md:grid-cols-12">
            <Heading className="md:col-span-7">Hand off without starting over.</Heading>
            <p className="max-w-[30rem] text-[18px] leading-[1.65] text-dim md:col-span-5 md:self-end">
              When an agent finishes, hand its conversation to any other agent
              you have. It opens beside the first, in the same folder, already
              knowing what you asked, what was done, and where it stopped.
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
              <HandoffDeck step={step} />
              <Carried step={step} />
              <span className="text-[13px] text-faint">
                Written to a git-ignored folder in the project, so every agent can read it.
              </span>
            </div>
          </div>
        </Container>
      </section>
    </MotionConfig>
  );
}
