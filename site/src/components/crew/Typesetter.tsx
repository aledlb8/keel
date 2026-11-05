"use client";

import { motion } from "motion/react";
import { useEffect, useState, type RefObject } from "react";

import { MiniClaude, type Pose, type TagState } from "./MiniClaude";
import { arc, glyphTop, useActor, wait, type Pt } from "./stage";

/*
 * A heading's typesetter: a mini Claude walks along the tops of the letters,
 * hops the spaces, jumps back to the start of each new line like a carriage
 * return, and every letter lands just before its feet do. At the end it
 * hammers the full stop in and sits on it.
 */

interface Leg {
  pose: Pose;
  face: 1 | -1;
  xs: number[];
  ys: number[];
  times?: number[];
  duration: number;
}

export interface TypesetPlan {
  fontSize: number;
  start: Pt;
  legs: Leg[];
  /** Seconds after the start at which each letter begins to fly in. */
  delays: number[];
  /** Ends on a full stop worth hammering. */
  stop: boolean;
}

const DROP = 0.4;
const SETTLE = 0.12;
/** A letter starts this long before the feet arrive, so it is there to stand on. */
const LEAD = 0.34;

interface Box {
  i: number;
  ch: string;
  l: number;
  r: number;
  line: number;
  top: number;
  word: number;
}

function boxOf(el: HTMLElement, i: number): Box {
  const ch = el.textContent ?? "";
  return {
    i,
    ch,
    l: el.offsetLeft,
    r: el.offsetLeft + el.offsetWidth,
    line: el.offsetTop,
    top: el.offsetTop + glyphTop(el, ch),
    word: Number(el.dataset.word ?? 0),
  };
}

/** Where the typesetter rests: on top of the last character. */
export function restPoint(root: HTMLElement): Pt | null {
  const all = root.querySelectorAll<HTMLElement>("[data-ch]");
  const el = all[all.length - 1];
  if (!el) return null;
  const b = boxOf(el, 0);
  return [(b.l + b.r) / 2, b.top];
}

export function planTypeset(root: HTMLElement): TypesetPlan | null {
  const els = Array.from(root.querySelectorAll<HTMLElement>("[data-ch]"));
  if (els.length < 2) return null;
  const fs = parseFloat(getComputedStyle(els[0]!).fontSize);
  const boxes = els.map(boxOf);
  const last = boxes[boxes.length - 1]!;
  const stop = /[.!?]/.test(last.ch);
  const walked = stop ? boxes.slice(0, -1) : boxes;

  const lines: Box[][] = [];
  for (const b of walked) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line[0]!.line - b.line) < 2) line.push(b);
    else lines.push([b]);
  }

  const speed = fs * 12;
  const inset = (b: Box) => Math.min((b.r - b.l) * 0.28, fs * 0.09);
  const delays = boxes.map(() => 0);
  const legs: Leg[] = [];
  const first = lines[0]![0]!;
  const start: Pt = [first.l + inset(first), first.top];
  let cur: Pt = start;
  let t = DROP + SETTLE;

  lines.forEach((line, k) => {
    const head = line[0]!;
    if (k > 0) {
      // Carriage return: one leap back to the start of the next line.
      const to: Pt = [head.l + inset(head), head.top];
      const { xs, ys } = arc(cur, to, fs * 0.42, 16);
      const duration = 0.42 + Math.abs(to[0] - cur[0]) / (speed * 5);
      legs.push({ pose: "hop", face: to[0] < cur[0] ? -1 : 1, xs, ys, duration });
      t += duration + 0.08;
      cur = to;
    }

    const xs = [cur[0]];
    const ys = [cur[1]];
    const ts = [0];
    let lt = 0;
    const add = (x: number, y: number, slow = 1) => {
      const dx = x - xs[xs.length - 1]!;
      const dy = y - ys[ys.length - 1]!;
      lt += (Math.hypot(dx, dy * 0.6) / speed) * slow;
      xs.push(x);
      ys.push(y);
      ts.push(lt);
    };
    const jump = (to: Pt, lift: number, slow: number) => {
      const from: Pt = [xs[xs.length - 1]!, ys[ys.length - 1]!];
      const a = arc(from, to, lift, 6);
      for (let j = 1; j < a.xs.length; j++) add(a.xs[j]!, a.ys[j]!, slow);
    };

    line.forEach((b, j) => {
      const p0: Pt = [b.l + inset(b), b.top];
      if (j > 0) {
        const prev = line[j - 1]!;
        if (b.word !== prev.word) jump(p0, fs * 0.22, 1.25);
        else if (Math.abs(p0[1] - ys[ys.length - 1]!) > fs * 0.04) jump(p0, fs * 0.06, 1.1);
        else add(p0[0], p0[1]);
      }
      const arrive = lt;
      add(b.r - inset(b), b.top);
      delays[b.i] = Math.max(0, t + (arrive + lt) / 2 - LEAD);
    });

    if (lt > 0) {
      legs.push({ pose: "walk", face: 1, xs, ys, times: ts.map((v) => v / lt), duration: lt });
    }
    t += lt;
    cur = [xs[xs.length - 1]!, ys[ys.length - 1]!];
  });

  if (stop) {
    // Hop down onto the full stop, which flies in to meet the feet.
    const to: Pt = [(last.l + last.r) / 2, last.top];
    const { xs, ys } = arc(cur, to, fs * 0.16, 10);
    legs.push({ pose: "hop", face: 1, xs, ys, duration: 0.34 });
    delays[last.i] = Math.max(0, t + 0.34 - LEAD * 0.7);
  }

  return { fontSize: fs, start, legs, delays, stop };
}

/** Spinner verbs in Claude Code's manner, picked per heading so the crew varies. */
const VERBS = [
  "Typesetting",
  "Kerning",
  "Laying type",
  "Assembling",
  "Lettering",
  "Composing",
  "Setting type",
  "Hammering",
];

export function verbFor(text: string) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return VERBS[h % VERBS.length]!;
}

export function Typesetter({
  root,
  plan,
  go,
  rest = false,
  verb,
}: {
  root: RefObject<HTMLElement | null>;
  plan: TypesetPlan | null;
  /** Start the walk. */
  go: boolean;
  /** No walk at all: just sit on the last character (reduced motion). */
  rest?: boolean;
  verb: string;
}) {
  const actor = useActor();
  const [pose, setPose] = useState<Pose>("hop");
  const [face, setFace] = useState<1 | -1>(1);
  const [tag, setTag] = useState<TagState>(null);
  const [side, setSide] = useState<"top" | "right">("top");
  const [settled, setSettled] = useState(false);

  // Reduced motion: already done, sitting on the full stop.
  useEffect(() => {
    if (!rest) return;
    let live = true;
    void document.fonts.ready.then(() => {
      const el = root.current;
      const at = el && restPoint(el);
      if (!live || !at) return;
      actor.place(at);
      actor.opacity.jump(1);
      setPose("sit");
      setSettled(true);
    });
    return () => {
      live = false;
    };
  }, [rest, root, actor]);

  useEffect(() => {
    if (!go || !plan || rest) return;
    actor.script(async (alive) => {
      const [sx, sy] = plan.start;
      const h = plan.fontSize * 1.3;
      actor.place([sx, sy - h]);
      setPose("hop");
      setTag("working");
      void actor.show(true, 0.18);
      // A fall, accelerating, onto the first letter.
      const fall = Array.from({ length: 9 }, (_, i) => sy - h * (1 - (i / 8) ** 2));
      await actor.path(fall.map(() => sx), fall, DROP);
      if (!alive()) return;
      void actor.land(0.9);
      await wait(SETTLE * 1000);

      for (const leg of plan.legs) {
        if (!alive()) return;
        setPose(leg.pose);
        setFace(leg.face);
        await actor.path(leg.xs, leg.ys, leg.duration, leg.times);
        if (leg.pose === "hop") void actor.land(0.7);
        if (leg.pose === "hop" && leg !== plan.legs[plan.legs.length - 1]) await wait(80);
      }
      if (!alive()) return;
      setFace(1);
      if (plan.stop) {
        setPose("hammer");
        await wait(1040);
        if (!alive()) return;
      }
      setPose("sit");
      const el = root.current;
      const at = el && restPoint(el);
      if (at) actor.place(at);
      // "Done" goes beside it if there is room, rather than over the line above.
      const box = el?.offsetParent?.getBoundingClientRect();
      if (box && at) {
        const room = window.innerWidth - (box.left + at[0] + plan.fontSize * 0.4);
        setSide(room > 80 ? "right" : "top");
      }
      setTag("done");
      setSettled(true);
      await wait(2600);
      if (alive()) setTag(null);
    });
    return () => actor.retire();
  }, [go, plan, rest, root, actor]);

  // Once it has sat down, keep it on the full stop as the heading reflows.
  useEffect(() => {
    const el = root.current;
    const box = el?.offsetParent;
    if (!settled || !el || !box) return;
    const ro = new ResizeObserver(() => {
      const at = restPoint(el);
      if (at) actor.place(at);
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [settled, root, actor]);

  return (
    <span aria-hidden className="mc-stage">
      <motion.span className="mc-actor" style={actor.style}>
        <MiniClaude
          pose={pose}
          face={face}
          hat
          tool="hammer"
          size="clamp(24px, 0.6em, 46px)"
          look={pose === "sit" ? [0, 0.35] : [0.6, 0]}
          tag={tag}
          tagSide={side}
          tagText={tag === "done" ? "Done" : `${verb}…`}
          blink={plan ? plan.fontSize % 3 : 1}
        />
      </motion.span>
    </span>
  );
}
