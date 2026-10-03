"use client";

import { motion } from "motion/react";
import { useState } from "react";

import { AGENTS, AGENT_ORDER, AgentMark, gridRects, gridRows } from "./marks";
import { AnimatedTabs } from "./rare/AnimatedTabs";
import { Container, Heading } from "./ui";

const MAX = 10;
const ROSTER = [...AGENT_ORDER.slice(0, 5), "shell", ...AGENT_ORDER.slice(5)] as const;
const COUNTS = Array.from({ length: MAX }, (_, i) => ({ value: i + 1, label: String(i + 1) }));

/** A few rows of fake terminal, so a tile reads as a pane rather than a box. */
function Ghost({ seed }: { seed: number }) {
  const widths = [72, 48, 86, 34, 64, 52, 78, 40];
  return (
    <div className="flex flex-col gap-[7px] px-3 pt-1">
      {Array.from({ length: 6 }, (_, i) => (
        <span
          key={i}
          className="h-[5px] rounded-full bg-white/[0.06]"
          style={{ width: `${widths[(i + seed) % widths.length]}%` }}
        />
      ))}
    </div>
  );
}

export function GridLab() {
  const [count, setCount] = useState(7);
  const rows = gridRows(count);
  const rects = gridRects(count, 100, 100, 1.4);

  return (
    <section id="layout" className="relative py-24 sm:py-36">
      <Container>
        <div className="grid gap-10 md:grid-cols-12">
          <Heading className="md:col-span-7">Add a pane. The deck rebalances.</Heading>
          <p className="max-w-[30rem] text-[18px] leading-[1.65] text-dim md:col-span-5 md:self-end">
            Rows never differ by more than one pane, and no slot is left empty.
            Open six at once or one at a time and you land on the same deck.
            Running terminals move; they never restart.
          </p>
        </div>

        <div className="mt-16 grid gap-10 lg:mt-24 lg:grid-cols-12 lg:gap-14">
          <div className="flex flex-col justify-between gap-10 lg:col-span-3">
            <div className="flex items-end gap-4">
              <motion.span
                key={count}
                initial={{ opacity: 0, y: 18, filter: "blur(6px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                className="display block text-[clamp(6rem,11vw,10rem)] tabular-nums"
                aria-live="polite"
              >
                {count}
              </motion.span>
              <span className="pb-4 text-[18px] text-dim">{count === 1 ? "pane" : "panes"}</span>
            </div>

            <dl className="grid grid-cols-2 gap-6 text-[15px] lg:grid-cols-1">
              <div>
                <dt className="text-faint">Panes per row</dt>
                <dd className="mt-1 text-[22px] font-semibold tabular-nums">{rows.join(", ")}</dd>
              </div>
              <div>
                <dt className="text-faint">Columns at most</dt>
                <dd className="mt-1 text-[22px] font-semibold tabular-nums">
                  {Math.ceil(Math.sqrt(count))}
                </dd>
              </div>
            </dl>
          </div>

          <div className="lg:col-span-9">
            <div className="relative rounded-[18px] bg-void p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.07)]">
              <div className="relative aspect-[16/10] w-full">
                {ROSTER.slice(0, MAX).map((agent, i) => {
                  const r = rects[i];
                  const shown = i < count;
                  const target = r ?? rects[rects.length - 1]!;
                  return (
                    <motion.div
                      key={agent}
                      initial={false}
                      animate={{
                        left: `${target.x}%`,
                        top: `${target.y}%`,
                        width: `${target.w}%`,
                        height: `${target.h}%`,
                        opacity: shown ? 1 : 0,
                        scale: shown ? 1 : 0.9,
                      }}
                      transition={{ type: "spring", stiffness: 260, damping: 30 }}
                      className="sheen absolute flex flex-col overflow-hidden rounded-[10px] bg-slab"
                      style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 0 0 1px rgba(255,255,255,0.05)" }}
                      aria-hidden
                    >
                      <div className="flex h-8 shrink-0 items-center gap-2 px-3">
                        <AgentMark agent={agent} size={16} />
                        <span className="truncate text-[12px] text-dim">{AGENTS[agent].name}</span>
                      </div>
                      <Ghost seed={i} />
                    </motion.div>
                  );
                })}
              </div>
            </div>
            <div className="mt-5 flex justify-center">
              <AnimatedTabs
                id="panes"
                label="Number of panes"
                options={COUNTS}
                value={count}
                onChange={setCount}
                itemClassName="h-9 w-[30px] text-[14px] sm:h-10 sm:w-10 sm:text-[15px]"
              />
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
