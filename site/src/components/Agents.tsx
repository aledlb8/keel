"use client";

import { useInView } from "motion/react";
import { Fragment, useEffect, useRef, useState } from "react";

import { AGENTS, AGENT_ORDER, AgentMark, StatusDot, type AgentId } from "./marks";
import { Container, Heading } from "./ui";

const STATES = [
  {
    status: "working",
    name: "Working",
    body: "Mid-turn. The agent's own lifecycle hooks say so, not a guess read off the screen.",
  },
  {
    status: "done",
    name: "Done",
    body: "Finished while you were looking somewhere else. It chimes once, and F8 takes you there.",
  },
  {
    status: "idle",
    name: "Idle",
    body: "At rest, or it finished in the pane you were already watching. That was never news.",
  },
] as const;

export function Agents() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const [auto, setAuto] = useState(0);
  const [hover, setHover] = useState<AgentId | null>(null);

  useEffect(() => {
    if (!inView || hover) return;
    const id = setInterval(() => setAuto((n) => (n + 1) % AGENT_ORDER.length), 1500);
    return () => clearInterval(id);
  }, [inView, hover]);

  const lit = hover ?? (inView ? AGENT_ORDER[auto] : null);

  return (
    <section id="agents" className="relative py-24 sm:py-36">
      <Container>
        <div className="grid gap-10 md:grid-cols-12">
          <Heading className="md:col-span-7">The only colour in Keel is information.</Heading>
          <p className="max-w-[30rem] text-[18px] leading-[1.65] text-dim md:col-span-5 md:self-end">
            The chrome is pure graphite. Colour answers two questions: which
            agent is this, and what is it doing? Everything else stays out of
            the way, so ten panes still read at a glance.
          </p>
        </div>

        <div ref={ref} className="mt-20 sm:mt-28">
          <p className="mb-6 text-[15px] text-faint">
            Which agent. Keel runs the CLIs you already have installed:
          </p>
          <p
            className="text-[clamp(2rem,5.4vw,5.25rem)] leading-[1.08] font-[800] tracking-[-0.035em] [font-stretch:112%]"
            onPointerLeave={() => setHover(null)}
          >
            {AGENT_ORDER.map((id, i) => {
              const on = lit === id;
              return (
                <Fragment key={id}>
                  <span
                    onPointerEnter={() => setHover(id)}
                    className="inline-flex cursor-default items-center gap-[0.22em] whitespace-nowrap transition-[color,text-shadow] duration-500"
                    style={{
                      color: on ? AGENTS[id].accent : "#2e2e2e",
                      textShadow: on
                        ? `0 0 60px color-mix(in srgb, ${AGENTS[id].accent} 45%, transparent)`
                        : "none",
                    }}
                  >
                    <AgentMark agent={id} variant="glyph" fluid />
                    {AGENTS[id].name}
                  </span>
                  {i < AGENT_ORDER.length - 1 && <span className="text-[#1f1f1f]"> / </span>}
                </Fragment>
              );
            })}
          </p>
          <p className="mt-6 max-w-[36rem] text-[15px] leading-[1.6] text-faint">
            Anything else goes in the catalogue with its own command, profiles,
            colour and discovery paths.
          </p>
        </div>

        <div className="mt-24 sm:mt-32">
          <p className="mb-8 text-[15px] text-faint">What it is doing. Three states, one dot each:</p>
          <div className="grid gap-px overflow-hidden rounded-[16px] bg-white/[0.06] md:grid-cols-3">
            {STATES.map((s) => (
              <div key={s.status} className="flex flex-col gap-5 bg-ground p-8 sm:p-10">
                <div className="flex items-center gap-4">
                  <span className="relative grid size-5 place-items-center">
                    {s.status !== "idle" && (
                      <span
                        className={`absolute inset-0 rounded-full blur-md ${s.status === "working" ? "pulse-dot" : ""}`}
                        style={{ background: `var(--k-${s.status})`, opacity: 0.6 }}
                      />
                    )}
                    <StatusDot status={s.status} size={14} />
                  </span>
                  <span className="text-[28px] font-[750] tracking-[-0.02em] [font-stretch:115%]">
                    {s.name}
                  </span>
                </div>
                <p className="max-w-[22rem] text-[16px] leading-[1.6] text-dim">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}
