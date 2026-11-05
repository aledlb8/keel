"use client";

import { motion } from "motion/react";
import { useEffect, useRef, useState, type RefObject } from "react";

import { MiniClaude, type Pose } from "./MiniClaude";
import { hopTo, topOf, useActor, wait } from "./stage";

/**
 * Hops to the `target` name and paints it in that agent's colour, reporting
 * each landing through `onPainted` so the colour arrives with the brush. Each
 * name in `container` is `[data-agent=<id>]`, its first letter `[data-cap]`,
 * which is what it stands on.
 */
export function Painter({
  container,
  target: lit,
  paint,
  onPainted,
}: {
  container: RefObject<HTMLElement | null>;
  target: string | null;
  paint: string;
  onPainted: (id: string) => void;
}) {
  const actor = useActor();
  const [pose, setPose] = useState<Pose>("hop");
  const [face, setFace] = useState<1 | -1>(1);
  const [brush, setBrush] = useState(paint);
  const here = useRef<string | null>(null);

  useEffect(() => {
    const box = container.current;
    const cap = lit ? box?.querySelector<HTMLElement>(`[data-agent="${lit}"] [data-cap]`) : null;
    if (!box || !cap || here.current === lit) return;
    const first = here.current === null;
    here.current = lit;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    actor.script(async (alive) => {
      const to = topOf(cap, box, cap.textContent ?? "");
      if (reduce) {
        actor.place(to);
        actor.opacity.jump(1);
        setBrush(paint);
        setPose("paint");
        onPainted(lit!);
        return;
      }
      if (first) {
        actor.place([to[0], to[1] - 120]);
        void actor.show(true, 0.2);
      }
      setFace(to[0] < actor.pos[0] - 1 ? -1 : 1);
      setPose("hop");
      if (first) {
        await actor.path([to[0], to[0]], [to[1] - 120, to[1]], 0.42);
      } else {
        await hopTo(actor, to, { lift: 30 });
      }
      if (!alive()) return;
      void actor.land(0.7);
      setFace(1);
      setBrush(paint);
      setPose("paint");
      await wait(140);
      if (alive()) onPainted(lit!);
    });
  }, [lit, paint, container, actor, onPainted]);

  useEffect(() => () => actor.retire(), [actor]);

  // Stay on the letter as the list reflows.
  useEffect(() => {
    const box = container.current;
    if (!box) return;
    const ro = new ResizeObserver(() => {
      const cap = here.current
        ? box.querySelector<HTMLElement>(`[data-agent="${here.current}"] [data-cap]`)
        : null;
      if (cap && pose === "paint") actor.place(topOf(cap, box, cap.textContent ?? ""));
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [container, actor, pose]);

  return (
    <span aria-hidden className="mc-stage">
      <motion.span className="mc-actor" style={actor.style}>
        <MiniClaude
          pose={pose}
          face={face}
          tool="brush"
          paint={brush}
          size="clamp(26px, 0.58em, 52px)"
          look={pose === "paint" ? [0.5, 0.45] : [0.6, 0]}
          blink={2.3}
        />
      </motion.span>
    </span>
  );
}
