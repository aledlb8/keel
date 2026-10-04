"use client";

import {
  motion,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Workspace } from "./demo/Workspace";
import { FeatureBadge } from "./rare/FeatureBadge";
import { ShimmerLink } from "./rare/ShimmerLink";
import { Container, GithubIcon, Kbd, RELEASES, REPO } from "./ui";

function DemoFrame() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [live, setLive] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setLive(!!e?.isIntersecting), {
      threshold: 0.04,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const compact = width > 0 && width < 820;
  const dw = compact ? 640 : 1280;
  const dh = compact ? 780 : 800;
  const scale = width / dw;

  return (
    <div
      ref={ref}
      className="relative w-full"
      style={{ height: width ? dh * scale : undefined, aspectRatio: width ? undefined : "1280 / 800" }}
    >
      {width > 0 && (
        <div
          className="absolute top-0 left-0"
          style={{ width: dw, height: dh, transform: `scale(${scale})`, transformOrigin: "0 0" }}
        >
          <Workspace compact={compact} live={live} />
        </div>
      )}
    </div>
  );
}

export function Hero() {
  // The server cannot know the preference, so the first client render matches
  // it (tilted) and only then lays the window flat.
  const prefersReduced = useReducedMotion();
  const [reduce, setReduce] = useState(false);
  useEffect(() => setReduce(!!prefersReduced), [prefersReduced]);
  const stage = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: stage,
    offset: ["start end", "start 0.18"],
  });
  const eased = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.4 });
  const rotateX = useTransform(eased, [0, 1], [26, 0]);
  const scale = useTransform(eased, [0, 1], [0.88, 1]);
  const y = useTransform(eased, [0, 1], [60, 0]);
  const glow = useTransform(eased, [0, 1], [0.35, 1]);

  return (
    <section id="top" className="relative pt-32 sm:pt-40">
      {/* Overhead light, so the window reads as an object lifted off the ground. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[900px] bg-[radial-gradient(60%_50%_at_50%_0%,rgba(255,255,255,0.075),transparent_70%)]"
      />

      <Container className="relative">
        <div className="rise mb-8 sm:mb-10" style={{ animationDelay: "0.15s" }}>
          <FeatureBadge href={REPO} badge="MIT">
            Free and open source
          </FeatureBadge>
        </div>
        <h1 className="text-[clamp(2rem,9.3vw,9.4rem)]">
          <span className="display mass-in block whitespace-nowrap">Run ten agents.</span>
          <span
            className="light-in block whitespace-nowrap leading-[1] tracking-[-0.045em] text-ink/90"
            style={{ fontWeight: 200, fontStretch: "100%", animationDelay: "0.35s" }}
          >
            Lose track of none.
          </span>
        </h1>

        <div className="mt-10 grid gap-8 md:mt-14 md:grid-cols-12 md:items-end">
          <p
            className="rise max-w-[36rem] text-[18px] leading-[1.6] text-dim md:col-span-7 md:text-[19px]"
            style={{ animationDelay: "0.9s" }}
          >
            Keel is a native desktop workspace for the coding agents already on
            your machine. Claude Code, Codex, Gemini CLI, opencode and the rest
            each get a pane, every pane stays in view, and Keel tells you the
            moment one of them needs you, even when you're away and only have
            your phone.
          </p>
          <div
            className="rise flex flex-wrap items-center gap-3 md:col-span-5 md:justify-end"
            style={{ animationDelay: "1.05s" }}
          >
            <ShimmerLink href={RELEASES}>Download Keel</ShimmerLink>
            <a
              href={REPO}
              className="flex h-12 items-center gap-2.5 rounded-[11px] px-5 text-[16px] text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] transition-colors hover:bg-veil-2"
            >
              <GithubIcon size={18} />
              Read the source
            </a>
          </div>
        </div>
      </Container>

      <div id="demo" ref={stage} className="relative mt-20 sm:mt-28" style={{ perspective: 1600 }}>
        <Container>
          <motion.div
            style={
              reduce
                ? { rotateX: 0, scale: 1, y: 0, transformOrigin: "50% 0%" }
                : { rotateX, scale, y, transformOrigin: "50% 0%" }
            }
            className="relative"
          >
            <motion.div
              aria-hidden
              style={{ opacity: glow }}
              className="pointer-events-none absolute -inset-x-24 -top-64 bottom-1/3 -z-10 bg-[radial-gradient(45%_45%_at_50%_50%,rgba(255,255,255,0.08),transparent_100%)]"
            />
            <div className="relative rounded-[18px] p-[3px] shadow-[0_60px_140px_-30px_rgba(0,0,0,1),0_30px_60px_-30px_rgba(0,0,0,0.9)] [background:linear-gradient(180deg,rgba(255,255,255,0.14),rgba(255,255,255,0.02)_40%)]">
              <DemoFrame />
            </div>
          </motion.div>

          <div className="mt-8 flex flex-col gap-4 text-[15px] text-dim sm:flex-row sm:flex-wrap sm:items-center sm:justify-center sm:gap-x-10">
            <span>This is a live demo. Click a pane and give it a task.</span>
            <span className="flex items-center gap-2.5">
              <Kbd>F8</Kbd> jumps to the agent that finished
            </span>
            <span className="flex items-center gap-2.5">
              <Kbd>Ctrl</Kbd>
              <Kbd>O</Kbd> shows every deck
            </span>
          </div>
        </Container>
      </div>
    </section>
  );
}
