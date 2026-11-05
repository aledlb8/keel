"use client";

import { motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { Typesetter, planTypeset, verbFor, type TypesetPlan } from "../crew/Typesetter";

/*
 * Adapted from RareUI's MagneticScatterText (MIT, see ./LICENSE). The letters
 * start scattered and pull together the first time the line scrolls into view.
 * The hover scatter is gone: these are headings people read, and the scatter
 * is a third as far so a line assembles rather than explodes. Words stay whole
 * so the line still wraps (and balances) like ordinary text.
 *
 * With `crew`, a mini Claude sets the line: each letter lands just ahead of
 * its feet instead of on a fixed stagger (see ../crew/Typesetter). The
 * surrounding element must be positioned, since that is what it walks on.
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

export function ScatterText({
  text,
  className = "",
  crew = false,
}: {
  text: string;
  className?: string;
  crew?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduce = useReducedMotion();
  // The server cannot know the preference, so the first client render matches
  // it (letters) and only then drops to plain text.
  const [plain, setPlain] = useState(false);
  useEffect(() => setPlain(!!reduce), [reduce]);
  const [plan, setPlan] = useState<TypesetPlan | null>(null);
  const [go, setGo] = useState(false);

  useEffect(() => {
    if (!inView || plain) return;
    if (!crew) {
      setGo(true);
      return;
    }
    // Measure once the face is in, or the route runs over the fallback's letters.
    let live = true;
    void document.fonts.ready.then(() => {
      if (!live) return;
      setPlan(ref.current ? planTypeset(ref.current) : null);
      setGo(true);
    });
    return () => {
      live = false;
    };
  }, [inView, plain, crew]);

  const words = text.split(" ");

  if (plain) {
    // The last character stays addressable so the crew can sit on it.
    const lastWord = words[words.length - 1] ?? "";
    return (
      <span ref={ref} className={className}>
        {words.slice(0, -1).join(" ")}
        {words.length > 1 && " "}
        <span className="inline-block whitespace-nowrap">
          {lastWord.slice(0, -1)}
          <span data-ch className="inline-block">
            {lastWord.slice(-1)}
          </span>
        </span>
        {crew && <Typesetter root={ref} plan={null} go={false} rest verb="" />}
      </span>
    );
  }

  let n = 0;
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
                    data-ch
                    data-word={w}
                    className="inline-block"
                    initial={{ ...r, opacity: 0, scale: 0.6, filter: "blur(8px)" }}
                    animate={
                      go
                        ? { x: 0, y: 0, rotate: 0, opacity: 1, scale: 1, filter: "blur(0px)" }
                        : undefined
                    }
                    transition={{
                      type: "spring",
                      damping: 16,
                      stiffness: 110,
                      mass: 0.7,
                      delay: plan ? (plan.delays[i] ?? 0) : i * 0.014,
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
      {crew && <Typesetter root={ref} plan={plan} go={go && !!plan} verb={verbFor(text)} />}
    </span>
  );
}
