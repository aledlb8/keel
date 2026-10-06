"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";

import { KeelMark } from "./marks";
import { ShimmerLink } from "./rare/ShimmerLink";
import { GithubIcon, RELEASES, REPO } from "./ui";

const LINKS = [
  ["Demo", "demo"],
  ["Agents", "agents"],
  ["Layout", "layout"],
  ["Features", "features"],
  ["Handoff", "handoff"],
  ["Phone", "phone"],
  ["Keys", "keys"],
] as const;

type Section = (typeof LINKS)[number][1];

/** The section whose body crosses the middle band of the viewport. */
function useCurrentSection() {
  const [current, setCurrent] = useState<Section | null>(null);
  useEffect(() => {
    const seen = new Map<Section, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id as Section, e.isIntersecting);
        setCurrent(LINKS.map(([, id]) => id).find((id) => seen.get(id)) ?? null);
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    for (const [, id] of LINKS) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);
  return current;
}

/*
 * After RareUI's FloatingNavigation (MIT, see ./rare/LICENSE): one floating
 * bar, a pill that springs to the section you are reading, a softer one that
 * follows the pointer. Text instead of icons, and Keel's nested radii instead
 * of a capsule.
 */
export function Nav() {
  const current = useCurrentSection();
  const [hover, setHover] = useState<Section | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3 sm:pt-4">
      <nav
        className={`pointer-events-auto flex w-full max-w-[1080px] items-center gap-2 rounded-[16px] py-1.5 pr-1.5 pl-4 transition-[background-color,box-shadow,backdrop-filter] duration-500 ease-keel ${
          scrolled
            ? "bg-[#0e0e0e]/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_0_0_1px_rgba(255,255,255,0.07),0_18px_50px_-18px_rgba(0,0,0,0.95)] backdrop-blur-xl backdrop-saturate-150"
            : "bg-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0),0_0_0_1px_rgba(255,255,255,0)]"
        }`}
      >
        <a href="#top" className="mr-2 flex items-center gap-2.5 text-ink" aria-label="Keel, back to top">
          <KeelMark size={20} />
          <span className="text-[19px] font-[800] tracking-[-0.02em] [font-stretch:120%]">Keel</span>
        </a>

        <div
          className="hidden items-center md:flex"
          onPointerLeave={() => setHover(null)}
        >
          {LINKS.map(([label, id]) => {
            const on = current === id;
            return (
              <a
                key={id}
                href={`#${id}`}
                aria-current={on ? "location" : undefined}
                onPointerEnter={() => setHover(id)}
                className={`relative isolate rounded-[10px] px-3.5 py-2 text-[14px] transition-colors duration-200 ${
                  on ? "text-ink" : "text-dim hover:text-ink"
                }`}
              >
                {hover === id && !on && (
                  <motion.span
                    layoutId="nav-hover"
                    aria-hidden
                    className="absolute inset-0 -z-10 rounded-[10px] bg-white/[0.05]"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  />
                )}
                {on && (
                  <motion.span
                    layoutId="nav-active"
                    aria-hidden
                    className="absolute inset-0 -z-10 rounded-[10px] bg-white/[0.1] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                    transition={{ type: "spring", stiffness: 350, damping: 32 }}
                  />
                )}
                {label}
              </a>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <a
            href={REPO}
            aria-label="Source on GitHub"
            className="flex h-9 items-center gap-2 rounded-[10px] px-3 text-[14px] text-dim transition-colors hover:bg-veil-2 hover:text-ink"
          >
            <GithubIcon size={16} />
            <span className="hidden sm:inline">Source</span>
          </a>
          <ShimmerLink href={RELEASES} size="sm">
            Download
          </ShimmerLink>
        </div>
      </nav>
    </header>
  );
}
