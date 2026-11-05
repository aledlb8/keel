"use client";

import { motion, useMotionValueEvent, type MotionValue } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { MiniClaude, type Pose, type TagState } from "./MiniClaude";
import { glyphTop, useActor, wait, type Pt } from "./stage";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Rappels down onto the full stop of the headline once it has gained its
 * mass, hammers it in and sits on it. Render it inside a positioned span
 * around the full stop.
 */
export function Rigger() {
  const stage = useRef<HTMLSpanElement>(null);
  const actor = useActor();
  const [pose, setPose] = useState<Pose>("hang");
  const [tag, setTag] = useState<TagState>(null);
  const [roped, setRoped] = useState(true);
  const [settled, setSettled] = useState(false);

  const anchor = useCallback((): Pt | null => {
    const dot = stage.current?.parentElement;
    return dot ? [dot.offsetWidth / 2, glyphTop(dot, ".")] : null;
  }, []);

  useEffect(() => {
    actor.script(async (alive) => {
      await document.fonts.ready;
      if (!alive()) return;
      if (reducedMotion()) {
        const at = anchor();
        if (!at) return;
        actor.place(at);
        actor.opacity.jump(1);
        setRoped(false);
        setPose("sit");
        setSettled(true);
        return;
      }
      await wait(1300);
      const at = anchor();
      const dot = stage.current?.parentElement;
      if (!alive() || !at || !dot) return;
      // Start above the top of the window, or at least a rope's length up.
      const from = at[1] - Math.max(160, dot.getBoundingClientRect().top + at[1] + 90);
      actor.place([at[0], from]);
      void actor.show(true, 0.2);
      const d = at[1] - from;
      await actor.path(
        [at[0], at[0], at[0], at[0], at[0]],
        [from, at[1] - Math.min(36, d * 0.1), at[1] + 5, at[1] - 2, at[1]],
        1.35,
        [0, 0.64, 0.86, 0.94, 1],
      );
      if (!alive()) return;
      void actor.land(0.8);
      setRoped(false);
      setPose("stand");
      await wait(320);
      if (!alive()) return;
      setPose("hammer");
      setTag("working");
      await wait(1300);
      if (!alive()) return;
      setPose("sit");
      setTag("done");
      setSettled(true);
      const now = anchor();
      if (now) actor.place(now);
      await wait(2600);
      if (alive()) setTag(null);
    });
    return () => actor.retire();
  }, [actor, anchor]);

  useEffect(() => {
    const line = stage.current?.closest("h1");
    if (!settled || !line) return;
    const ro = new ResizeObserver(() => {
      const at = anchor();
      if (at) actor.place(at);
    });
    ro.observe(line);
    return () => ro.disconnect();
  }, [settled, actor, anchor]);

  return (
    <span ref={stage} aria-hidden className="mc-stage">
      <motion.span className="mc-actor" style={actor.style}>
        <MiniClaude
          pose={pose}
          hat
          tool="hammer"
          size="clamp(26px, 0.36em, 64px)"
          look={pose === "sit" ? [-0.4, 0.4] : [0, 0.5]}
          tag={tag}
          tagText={tag === "done" ? "Done" : "Laying the keel…"}
        >
          <span className="mc-rope" data-gone={roped ? undefined : ""} />
        </MiniClaude>
      </motion.span>
    </span>
  );
}

/**
 * Two of the crew on the top edge of the demo window. One bolts it upright
 * while the scroll lays it flat; the other climbs up once it is, sits, and
 * watches the agents work.
 */
export function DemoCrew({ progress, flat }: { progress: MotionValue<number>; flat: boolean }) {
  const [raised, setRaised] = useState(false);
  useMotionValueEvent(progress, "change", (v) => setRaised((r) => (r ? v > 0.9 : v > 0.975)));
  const up = flat || raised;

  const [boltTag, setBoltTag] = useState<TagState>("working");
  useEffect(() => {
    if (!up) {
      setBoltTag("working");
      return;
    }
    if (flat) {
      setBoltTag(null);
      return;
    }
    setBoltTag("done");
    const id = setTimeout(() => setBoltTag(null), 2400);
    return () => clearTimeout(id);
  }, [up, flat]);

  const layer = useRef<HTMLDivElement>(null);
  const actor = useActor();
  const [pose, setPose] = useState<Pose>("walk");
  const [waving, setWaving] = useState(false);
  const arrived = useRef(false);

  useEffect(() => {
    if (!up || arrived.current) return;
    arrived.current = true;
    actor.script(async (alive) => {
      if (flat) {
        actor.place([0, 0]);
        actor.opacity.jump(1);
        setPose("sit");
        return;
      }
      const w = layer.current?.offsetWidth ?? 1000;
      // Climb up over the right-hand corner, then walk to the seat.
      const edge = w * 0.2 - 18;
      actor.place([edge, 26]);
      setPose("hop");
      void actor.show(true, 0.2);
      await actor.path([edge, edge - 4, edge - 8], [26, -14, 0], 0.42, [0, 0.6, 1]);
      if (!alive()) return;
      void actor.land(0.6);
      await wait(160);
      setPose("walk");
      await actor.path([edge - 8, 0], [0, 0], 0.4 + edge / 260);
      if (!alive()) return;
      setPose("sit");
      await wait(500);
      while (alive()) {
        setWaving(true);
        await wait(1400);
        setWaving(false);
        await wait(11000);
      }
    });
    return () => actor.retire();
  }, [up, flat, actor]);

  return (
    <div ref={layer} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 select-none">
      <span className="absolute top-0 left-[21%]">
        <MiniClaude
          pose={up ? "sit" : "wrench"}
          hat
          tool="wrench"
          size="clamp(28px, 3vw, 44px)"
          look={up ? [0.2, 0.45] : [0.5, 0.3]}
          tag={boltTag}
          tagText={boltTag === "done" ? "Done" : "Raising the window…"}
          blink={1.7}
        />
      </span>
      <span className="absolute top-0 left-[80%]">
        <motion.span className="mc-actor" style={actor.style}>
          <MiniClaude
            pose={pose}
            face={pose === "walk" ? -1 : 1}
            size="clamp(28px, 3vw, 44px)"
            look={pose === "sit" ? [-0.5, 0.45] : [0.6, 0]}
            waving={waving}
            blink={3.1}
          />
        </motion.span>
      </span>
    </div>
  );
}
