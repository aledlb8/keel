"use client";

import { animate, useMotionValue, type AnimationPlaybackControls } from "motion/react";
import { useMemo, useRef } from "react";

export type Pt = readonly [number, number];

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Something a mini Claude can be moved by: its feet sit at (x, y) inside the
 * nearest positioned ancestor. Render `<motion.div className="mc-actor"
 * style={actor.style}>` around the MiniClaude.
 *
 * `script` starts a new routine and retires the previous one; a routine checks
 * `alive()` after every await and stops quietly once it is false.
 */
export function useActor() {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const opacity = useMotionValue(0);
  const scaleX = useMotionValue(1);
  const scaleY = useMotionValue(1);
  const running = useRef<AnimationPlaybackControls[]>([]);
  const token = useRef(0);

  return useMemo(() => {
    const track = (c: AnimationPlaybackControls) => {
      running.current.push(c);
      return c;
    };
    const stop = () => {
      for (const c of running.current) c.stop();
      running.current = [];
    };
    return {
      style: { x, y, opacity, scaleX, scaleY },
      x,
      y,
      opacity,
      get pos(): Pt {
        return [x.get(), y.get()];
      },
      place([px, py]: Pt) {
        x.jump(px);
        y.jump(py);
      },
      show(on = true, duration = 0.25) {
        return track(animate(opacity, on ? 1 : 0, { duration }));
      },
      /** Follow a polyline at constant speed between the given times (0..1). */
      path(xs: number[], ys: number[], duration: number, times?: number[]) {
        return Promise.all([
          track(animate(x, xs, { duration, times, ease: "linear" })),
          track(animate(y, ys, { duration, times, ease: "linear" })),
        ]);
      },
      /** The little squash of landing on something. */
      land(depth = 1) {
        return Promise.all([
          track(animate(scaleY, [1, 1 - 0.22 * depth, 1 + 0.06 * depth, 1], { duration: 0.34 })),
          track(animate(scaleX, [1, 1 + 0.14 * depth, 1 - 0.04 * depth, 1], { duration: 0.34 })),
        ]);
      },
      stop,
      script(fn: (alive: () => boolean) => Promise<void>) {
        stop();
        const mine = ++token.current;
        void fn(() => token.current === mine);
      },
      retire() {
        token.current++;
        stop();
      },
    };
  }, [x, y, opacity, scaleX, scaleY]);
}

export type Actor = ReturnType<typeof useActor>;

/** Points on a jump from `a` to `b` that peaks `lift` above the higher end. */
export function arc(a: Pt, b: Pt, lift: number, n = 12): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  const top = Math.min(a[1], b[1]) - lift;
  // A parabola through both ends and the peak, the peak nearer the higher end.
  const da = a[1] - top;
  const db = b[1] - top;
  const u0 = Math.sqrt(da) / (Math.sqrt(da) + Math.sqrt(db) || 1);
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    xs.push(a[0] + (b[0] - a[0]) * u);
    const k = u < u0 ? (u0 - u) / u0 : (u - u0) / (1 - u0 || 1);
    ys.push(top + (u < u0 ? da : db) * k * k);
  }
  return { xs, ys };
}

/** Jump the actor from where it is to `to`, facing the way it goes. */
export async function hopTo(
  actor: Actor,
  to: Pt,
  opts: { lift?: number; duration?: number } = {},
) {
  const from = actor.pos;
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const { xs, ys } = arc(from, to, opts.lift ?? 18 + dist * 0.18);
  await actor.path(xs, ys, opts.duration ?? 0.3 + Math.min(dist, 900) / 1800);
}

let ctx: CanvasRenderingContext2D | null = null;

/**
 * How far below the top of `el`'s box the ink of `ch` starts. Works for an
 * inline-block letter (box = its line) and a plain inline span (box = the
 * font's content area): either way the content area is centred in the box.
 */
export function glyphTop(el: HTMLElement, ch: string): number {
  const cs = getComputedStyle(el);
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return 0;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const m = ctx.measureText(ch || "x");
  const ascent = m.fontBoundingBoxAscent;
  const descent = m.fontBoundingBoxDescent;
  return (el.offsetHeight - (ascent + descent)) / 2 + ascent - m.actualBoundingBoxAscent;
}

/** Position of `el`'s top-centre ink inside `container`, from layout boxes. */
export function topOf(el: HTMLElement, container: HTMLElement, ch?: string): Pt {
  const a = el.getBoundingClientRect();
  const b = container.getBoundingClientRect();
  const y = a.top - b.top + (ch === undefined ? 0 : glyphTop(el, ch));
  return [a.left - b.left + a.width / 2, y];
}
