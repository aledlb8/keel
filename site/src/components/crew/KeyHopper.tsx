"use client";

import { motion, useInView } from "motion/react";
import { useEffect, useRef, useState, type RefObject } from "react";

import { MiniClaude, type Pose } from "./MiniClaude";
import { hopTo, useActor, wait, type Pt } from "./stage";

export interface Held {
  row: number;
  combo: number;
  /** How many keys of the chord are down, in order. */
  count: number;
}

/**
 * Hops across the shortcut list pressing chords one key at a time, the way a
 * hand would. Keys are `[data-key="row:combo:key"]` inside `container`. It
 * stands back whenever someone presses a real key (`quietUntil`).
 */
export function KeyHopper({
  container,
  chords,
  onHold,
  quietUntil,
}: {
  container: RefObject<HTMLElement | null>;
  /** Key counts per row, per combo. */
  chords: number[][];
  onHold: (held: Held | null) => void;
  quietUntil: RefObject<number>;
}) {
  const inView = useInView(container, { amount: 0.25 });
  const actor = useActor();
  const [pose, setPose] = useState<Pose>("hop");
  const [face, setFace] = useState<1 | -1>(1);
  const shown = useRef(false);

  useEffect(() => {
    const box = container.current;
    if (!inView || !box || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const keyTop = (row: number, combo: number, k: number): Pt | null => {
      const el = box.querySelector<HTMLElement>(`[data-key="${row}:${combo}:${k}"]`);
      if (!el) return null;
      const a = el.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return [a.left - b.left + a.width / 2, a.top - b.top];
    };

    actor.script(async (alive) => {
      let last = -1;
      while (alive()) {
        while (alive() && Date.now() < quietUntil.current) {
          setPose("stand");
          await wait(300);
        }
        let row = Math.floor(Math.random() * chords.length);
        if (row === last) row = (row + 1) % chords.length;
        last = row;
        const combos = chords[row]!;
        const combo = Math.floor(Math.random() * combos.length);
        const keys = combos[combo]!;

        for (let k = 0; k < keys; k++) {
          if (Date.now() < quietUntil.current) break;
          const to = keyTop(row, combo, k);
          if (!to || !alive()) return;
          if (!shown.current) {
            shown.current = true;
            actor.place([to[0], to[1] - 140]);
            void actor.show(true, 0.2);
          }
          setFace(to[0] < actor.pos[0] - 1 ? -1 : 1);
          setPose("hop");
          await hopTo(actor, to, { lift: k === 0 ? 34 : 14 });
          if (!alive()) return;
          void actor.land(0.9);
          setPose("stand");
          setFace(1);
          onHold({ row, combo, count: k + 1 });
          await wait(k === keys - 1 ? 0 : 170);
        }
        if (!alive()) return;
        if (Date.now() < quietUntil.current) continue;
        setPose("cheer");
        await wait(720);
        if (!alive()) return;
        onHold(null);
        setPose("stand");
        await wait(700 + Math.random() * 900);
      }
    });
    return () => {
      actor.retire();
      onHold(null);
      setPose("stand");
    };
  }, [inView, container, chords, onHold, quietUntil, actor]);

  return (
    <span aria-hidden className="mc-stage">
      <motion.span className="mc-actor" style={actor.style}>
        <MiniClaude
          pose={pose}
          face={face}
          size="32px"
          look={pose === "stand" || pose === "cheer" ? [0, 0.5] : [0.6, 0]}
          blink={0.6}
        />
      </motion.span>
    </span>
  );
}
