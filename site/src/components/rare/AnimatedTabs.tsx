"use client";

import { motion } from "motion/react";
import { useRef, useState, type KeyboardEvent } from "react";

/*
 * Adapted from RareUI's AnimatedTabs (MIT, see ./LICENSE). A single-choice
 * group with a pill that springs to the chosen option and a softer one that
 * follows the pointer. It behaves as a radio group: one tab stop, arrows move
 * the choice, Home and End jump to the ends.
 */
export function AnimatedTabs<T extends string | number>({
  options,
  value,
  onChange,
  label,
  id,
  className = "",
  itemClassName = "",
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
  /** Unique per group on the page, so pills never fly between groups. */
  id: string;
  className?: string;
  itemClassName?: string;
}) {
  const [hover, setHover] = useState<T | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = options.findIndex((o) => o.value === value);

  const move = (to: number) => {
    const i = (to + options.length) % options.length;
    onChange(options[i]!.value);
    refs.current[i]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const next = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: options.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    move(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      onPointerLeave={() => setHover(null)}
      className={`inline-flex items-center rounded-[13px] bg-white/[0.035] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_0_1px_rgba(255,255,255,0.07)] backdrop-blur-xl ${className}`}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <motion.button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            onPointerEnter={() => setHover(o.value)}
            whileTap={{ scale: 0.94 }}
            className={`relative isolate grid place-items-center rounded-[9px] font-semibold tabular-nums transition-colors duration-200 ${
              on ? "text-black" : "text-dim hover:text-ink"
            } ${itemClassName}`}
          >
            {hover === o.value && !on && (
              <motion.span
                layoutId={`${id}-hover`}
                aria-hidden
                className="absolute inset-0 -z-10 rounded-[9px] bg-white/[0.07]"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            {on && (
              <motion.span
                layoutId={`${id}-active`}
                aria-hidden
                className="absolute inset-0 -z-10 rounded-[9px] bg-ink shadow-[0_0_24px_-4px_rgba(255,255,255,0.45)]"
                transition={{ type: "spring", stiffness: 320, damping: 32, mass: 0.9 }}
              />
            )}
            {o.label}
          </motion.button>
        );
      })}
    </div>
  );
}
