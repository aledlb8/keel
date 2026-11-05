"use client";

import { motion, useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { MiniClaude, type Pose } from "./MiniClaude";
import { useActor, wait } from "./stage";

/** Claude Code's sign-off after a turn: "Worked for 2m 14s". */
function took(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * The end of the page: the crew knocks off on the footer's top line. Two walk
 * in from the sides, one drops in to report how long the build took (the time
 * you have had the page open), and all three sit.
 */
export function FooterCrew() {
  const layer = useRef<HTMLDivElement>(null);
  const inView = useInView(layer, { once: true, amount: 0.5 });
  const left = useActor();
  const mid = useActor();
  const right = useActor();
  const [poses, setPoses] = useState<[Pose, Pose, Pose]>(["walk", "hop", "walk"]);
  const [report, setReport] = useState<string | null>(null);
  const [waving, setWaving] = useState(false);

  useEffect(() => {
    const box = layer.current;
    if (!inView || !box) return;
    const pose = (i: number, p: Pose) =>
      setPoses((ps) => ps.map((q, j) => (j === i ? p : q)) as [Pose, Pose, Pose]);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const a of [left, mid, right]) {
        a.place([0, 0]);
        a.opacity.jump(1);
      }
      setPoses(["sit", "sit", "sit"]);
      setReport(took(performance.now()));
      return;
    }

    const w = box.offsetWidth;
    const walkIn = async (a: typeof left, i: number, from: number, alive: () => boolean) => {
      a.place([from, 0]);
      void a.show(true, 0.2);
      await a.path([from, 0], [0, 0], Math.abs(from) / 250);
      if (!alive()) return;
      pose(i, "sit");
    };

    left.script((alive) => walkIn(left, 0, -(w * 0.16 + 40), alive));
    right.script(async (alive) => {
      await walkIn(right, 2, w * 0.16 + 40, alive);
      await wait(600);
      while (alive()) {
        setWaving(true);
        await wait(1500);
        setWaving(false);
        await wait(9000);
      }
    });
    mid.script(async (alive) => {
      await wait(500);
      if (!alive()) return;
      mid.place([0, -150]);
      void mid.show(true, 0.15);
      const ys = Array.from({ length: 9 }, (_, i) => -150 * (1 - (i / 8) ** 2));
      await mid.path(ys.map(() => 0), ys, 0.48);
      if (!alive()) return;
      void mid.land(1);
      pose(1, "stand");
      setReport(took(performance.now()));
      await wait(900);
      if (alive()) pose(1, "sit");
    });
    return () => {
      left.retire();
      mid.retire();
      right.retire();
    };
  }, [inView, left, mid, right]);

  const spots = ["left-[16%]", "left-[50%]", "left-[84%]"];
  const actors = [left, mid, right];
  return (
    <div ref={layer} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 select-none">
      {actors.map((a, i) => (
        <span key={i} className={`absolute top-0 ${spots[i]}`}>
          <motion.span className="mc-actor" style={a.style}>
            <MiniClaude
              pose={poses[i]}
              face={poses[i] === "walk" && i === 2 ? -1 : 1}
              hat={i === 0}
              size="34px"
              look={poses[i] === "sit" ? [i === 0 ? 0.5 : -0.5, 0.2] : [0.6, 0]}
              waving={i === 2 && waving}
              tag={i === 1 && report ? "note" : null}
              tagText={report ? `Worked for ${report}` : ""}
              blink={i * 1.3}
            />
          </motion.span>
        </span>
      ))}
    </div>
  );
}
