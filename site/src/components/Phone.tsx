"use client";

import { AnimatePresence, MotionConfig, motion, useInView, useReducedMotion } from "motion/react";
import { Image as ImageIcon, KeyRound, Mic, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { AGENTS, AgentMark, KeelMark, StatusDot, gridRects, type AgentId, type PaneStatus } from "./marks";
import { Container, Heading } from "./ui";

const EASE = [0.22, 1, 0.36, 1] as const;

/*
 * One scripted exchange, a step every STEP_MS:
 *   a voice note goes out, its transcript comes back, the main agent starts
 *   Codex in Keel, and when Codex finishes the phone hears about it.
 */
const STEP_MS = 1150;
const STEPS = 12;
const FINAL = 9;

const POINTS: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <UserRound size={16} />,
    title: "Your agent, your login",
    body: "Claude Code, Codex, opencode, Pi or Grok Build answers, with the account it already uses on this PC.",
  },
  {
    icon: <Mic size={16} />,
    title: "Talk instead of type",
    body: "Voice notes are transcribed on your PC with Whisper, in English, Spanish or whichever you speak.",
  },
  {
    icon: <ImageIcon size={16} />,
    title: "Show it",
    body: "Send a screenshot of the bug. The agent gets the image itself, not your description of it.",
  },
  {
    icon: <KeyRound size={16} />,
    title: "Only you",
    body: "Pair with a one-time code from the Keel window. Everyone else gets silence.",
  },
];

function Wave({ playing }: { playing: boolean }) {
  const bars = [5, 9, 14, 8, 16, 11, 6, 13, 17, 9, 12, 7, 15, 10, 6, 11, 8, 5];
  return (
    <span className="flex h-5 items-center gap-[2px]" aria-hidden>
      {bars.map((h, i) => (
        <motion.span
          key={i}
          className="w-[2px] rounded-full bg-ink/70"
          initial={false}
          animate={{ height: playing ? [h * 0.5, h, h * 0.7] : h }}
          transition={playing ? { duration: 0.6, repeat: Infinity, repeatType: "mirror", delay: i * 0.04 } : { duration: 0.2 }}
        />
      ))}
    </span>
  );
}

function Bubble({ from, children }: { from: "me" | "bot"; children: ReactNode }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={{ duration: 0.4, ease: EASE }}
      className={`max-w-[86%] rounded-[16px] px-3 py-2 text-[13px] leading-[1.45] ${
        from === "me"
          ? "self-end rounded-br-[5px] bg-veil-3 text-ink"
          : "self-start rounded-bl-[5px] bg-raised text-ink/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
      }`}
    >
      {children}
    </motion.div>
  );
}

function PhoneChat({ step }: { step: number }) {
  return (
    <div className="relative mx-auto w-[300px] shrink-0 rounded-[40px] bg-[#0d0d0d] p-[9px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.09),0_40px_90px_-30px_rgba(0,0,0,1)]">
      <div className="flex h-[540px] flex-col overflow-hidden rounded-[32px] bg-void">
        <div className="flex items-center gap-2.5 border-b border-line px-4 pt-7 pb-3">
          <span className="grid size-8 place-items-center rounded-full bg-raised text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
            <KeelMark size={14} />
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-[13px] font-semibold text-ink">Keel</span>
            <span className="text-[11px] text-faint">{step >= 3 && step < FINAL - 1 ? "typing…" : "bot"}</span>
          </span>
        </div>

        <div className="flex flex-1 flex-col justify-end gap-2 px-3 pb-4">
          <AnimatePresence initial={false}>
            {step >= 1 && (
              <Bubble key="voice" from="me">
                <span className="flex items-center gap-2.5">
                  <span className="grid size-6 place-items-center rounded-full bg-ink text-black">
                    <Mic size={12} />
                  </span>
                  <Wave playing={step === 1} />
                  <span className="text-[11px] text-dim tabular-nums">0:04</span>
                </span>
              </Bubble>
            )}
            {step >= 2 && (
              <Bubble key="heard" from="bot">
                <span className="text-dim">🎤 </span>
                <span className="italic">“In keel, have Codex fix the flaky login test.”</span>
              </Bubble>
            )}
            {step >= 3 && step < 5 && (
              <motion.div
                key="working"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 self-start px-1 text-[11px] text-faint"
              >
                <StatusDot status="working" size={5} />
                Working · starting an agent
              </motion.div>
            )}
            {step >= 5 && (
              <Bubble key="started" from="bot">
                Started <b className="font-semibold text-ink">Codex</b> in keel. I&apos;ll tell you when it&apos;s done.
              </Bubble>
            )}
            {step >= FINAL && (
              <Bubble key="done" from="bot">
                <span className="text-done">✓ </span>
                <b className="font-semibold text-ink">Codex finished.</b> Fixed a race in{" "}
                <code className="font-mono text-[12px] text-ink">login.spec.ts</code>; all 48 tests pass.
              </Bubble>
            )}
          </AnimatePresence>
        </div>

        <div className="mx-3 mb-4 flex h-10 items-center gap-2 rounded-full bg-slab px-4 text-[12px] text-faint shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
          Message
          <Mic size={14} className="ml-auto" />
        </div>
      </div>
    </div>
  );
}

/** The same moment in Keel: a pane opens for Codex, works, and finishes. */
function DeckMirror({ step }: { step: number }) {
  const codexOpen = step >= 4;
  const codexStatus: PaneStatus = step >= FINAL ? "done" : codexOpen ? "working" : "idle";
  const panes: [AgentId, PaneStatus][] = [
    ["claude", "idle"],
    ["shell", "idle"],
    ...(codexOpen ? ([["codex", codexStatus]] as [AgentId, PaneStatus][]) : []),
  ];
  const rects = gridRects(panes.length, 100, 100, 2.4);
  const spin = AGENTS.codex.spinner;

  return (
    <div className="w-full max-w-[440px] rounded-[14px] bg-chrome p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_0_0_1px_rgba(255,255,255,0.08),0_30px_70px_-30px_rgba(0,0,0,1)]">
      <div className="mb-2 flex items-center gap-2 px-1.5 pt-0.5 text-[11px] text-faint">
        <KeelMark size={11} />
        <span className="text-dim">keel</span>
        <span className="ml-auto flex items-center gap-1.5 rounded-full px-2 py-0.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
          <StatusDot status={step >= 3 && step < FINAL ? "working" : "done"} size={5} />
          Telegram
        </span>
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
              className="absolute flex flex-col gap-1.5 overflow-hidden rounded-[7px] bg-slab p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_0_1px_rgba(255,255,255,0.05)]"
              style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
            >
              <span className="flex items-center gap-1.5 text-[10.5px] text-dim">
                <AgentMark agent={agent} size={13} />
                <span className="truncate">{AGENTS[agent].name}</span>
                <span className="ml-auto">
                  <StatusDot status={status} size={5} />
                </span>
              </span>
              {agent === "codex" ? (
                <span className="font-mono text-[10px] leading-[1.6] text-faint">
                  <span className="block truncate text-ink/80">› fix the flaky login test</span>
                  {status === "working" ? (
                    <span className="block" style={{ color: AGENTS.codex.accent }}>
                      {spin[step % spin.length]} Running tests…
                    </span>
                  ) : (
                    <span className="block text-done">✓ 48 passed</span>
                  )}
                </span>
              ) : (
                <>
                  <span className="h-[3px] w-3/4 rounded-full bg-white/[0.07]" />
                  <span className="h-[3px] w-1/2 rounded-full bg-white/[0.05]" />
                  <span className="h-[3px] w-2/3 rounded-full bg-white/[0.05]" />
                </>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

export function Phone() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.35 });
  const reduce = useReducedMotion();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => setTick((t) => t + 1), STEP_MS);
    return () => clearInterval(id);
  }, [inView, reduce]);

  // Without motion, show the exchange already finished.
  const step = reduce ? FINAL : tick % STEPS;

  return (
    <MotionConfig reducedMotion="user">
      <section id="phone" className="relative py-24 sm:py-36">
        <Container>
          <div className="grid gap-10 md:grid-cols-12">
            <Heading className="md:col-span-7">Keep working from your phone.</Heading>
            <p className="max-w-[30rem] text-[18px] leading-[1.65] text-dim md:col-span-5 md:self-end">
              Pair a Telegram bot with Keel and pick a main agent. It sees every
              project and pane, works in your repos, starts other agents in
              Keel, and messages you when they finish.
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

            <div className="relative flex flex-col items-center gap-10 lg:col-span-8 lg:flex-row lg:justify-center lg:gap-12">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(50%_50%_at_50%_50%,rgba(255,255,255,0.06),transparent_100%)]"
              />
              <PhoneChat step={step} />
              <div className="flex w-full flex-col items-center gap-3 lg:w-auto lg:flex-1">
                <DeckMirror step={step} />
                <span className="text-[13px] text-faint">The same moment, in Keel on your desk.</span>
              </div>
            </div>
          </div>
        </Container>
      </section>
    </MotionConfig>
  );
}
