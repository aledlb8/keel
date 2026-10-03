"use client";

import { motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/*
 * Adapted from RareUI's MagneticScatterText (MIT, see ./LICENSE). The letters
 * start scattered and pull together the first time the line scrolls into view.
 * The hover scatter is gone: these are headings people read, and the scatter
 * is a third as far so a line assembles rather than explodes. Words stay whole
 * so the line still wraps (and balances) like ordinary text.
 */

/**
 * Deterministic, so the server render and the client agree — and whole
 * numbers, because the server writes the starting transform rounded to four
 * places while the client writes every digit, and the two strings must match.
 */
function scatter(i: number) {
  const seed = i * 42;
  return {
    x: Math.round(Math.sin(seed) * 34),
    y: Math.round(Math.cos(seed) * 26),
    rotate: Math.round(Math.sin(seed * 2) * 24),
  };
}

export function ScatterText({ text, className = "" }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduce = useReducedMotion();
  // The server cannot know the preference, so the first client render matches
  // it (letters) and only then drops to plain text.
  const [plain, setPlain] = useState(false);
  useEffect(() => setPlain(!!reduce), [reduce]);

  if (plain) return <span className={className}>{text}</span>;

  let n = 0;
  const words = text.split(" ");
  return (
    <span ref={ref} className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {words.map((word, w) => (
          <span key={w}>
            <span className="inline-block whitespace-nowrap">
              {[...word].map((ch) => {
                const i = n++;
                const r = scatter(i);
                return (
                  <motion.span
                    key={i}
                    className="inline-block"
                    initial={{ ...r, opacity: 0, scale: 0.6, filter: "blur(8px)" }}
                    animate={
                      inView
                        ? { x: 0, y: 0, rotate: 0, opacity: 1, scale: 1, filter: "blur(0px)" }
                        : undefined
                    }
                    transition={{
                      type: "spring",
                      damping: 16,
                      stiffness: 110,
                      mass: 0.7,
                      delay: i * 0.014,
                    }}
                  >
                    {ch}
                  </motion.span>
                );
              })}
            </span>
            {w < words.length - 1 && " "}
          </span>
        ))}
      </span>
    </span>
  );
}
