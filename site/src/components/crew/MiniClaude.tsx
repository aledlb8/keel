"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { AGENTS } from "../marks";

/*
 * The crew: little Claude sparks that build the page while you read it.
 *
 * A mini Claude is drawn in a 28-unit box centred on its body, feet at the
 * bottom. It is placed by its feet (or, sitting, by its seat), so a parent only
 * has to say where the surface is. Poses are pure CSS, in globals.css under
 * "The crew".
 */

export type Pose =
  | "stand"
  | "walk"
  | "hop"
  | "sit"
  | "hang"
  | "hammer"
  | "paint"
  | "wrench"
  | "wave"
  | "cheer";

export type Tool = "hammer" | "brush" | "wrench";

type Ray = readonly [angle: number, length: number];

const CORE = 5.6;
const BASE_W = 2.2;
const TIP_W = 3;

/** The spark, with the bottom left open for the legs. */
const SIDE_RAYS: Ray[] = [
  [47, 9.6],
  [133, 9.4],
  [166, 9.8],
  [-160, 9],
];
/** Under a hard hat these three would poke through it, so they go. */
const TOP_RAYS: Ray[] = [
  [-90, 10.2],
  [-56, 9.4],
  [-124, 10],
];
/** The upper-right ray doubles as the waving arm. */
const ARM: Ray = [-21, 10.4];
/** The right ray holds the tool; its tip is the hand. */
const HAND: Ray = [14, 9];
const HAND_TIP = {
  x: +(Math.cos((HAND[0] * Math.PI) / 180) * HAND[1]).toFixed(2),
  y: +(Math.sin((HAND[0] * Math.PI) / 180) * HAND[1]).toFixed(2),
};

function RayShape({ len }: { len: number }) {
  const b = CORE * 0.5;
  return (
    <>
      <path d={`M${b} ${-BASE_W / 2}L${len} ${-TIP_W / 2}L${len} ${TIP_W / 2}L${b} ${BASE_W / 2}Z`} />
      <circle cx={len} r={TIP_W / 2} />
    </>
  );
}

const BODY = "#d97757";
const SHADE = "#a9553a";
const STEEL = "#cfcfcf";

/** Tools are drawn from the grip along +x, symmetric about y = 0. */
function ToolShape({ tool, paint }: { tool: Tool; paint: string }) {
  if (tool === "hammer") {
    return (
      <>
        <rect x={0} y={-0.6} width={8} height={1.2} rx={0.5} fill="#8a6343" />
        <rect x={6.6} y={-2.3} width={2.8} height={4.6} rx={0.7} fill={STEEL} />
        <rect x={6.6} y={-2.3} width={1} height={4.6} rx={0.5} fill="#9a9a9a" />
      </>
    );
  }
  if (tool === "brush") {
    return (
      <>
        <rect x={0} y={-0.55} width={6} height={1.1} rx={0.5} fill="#8a6343" />
        <rect x={5.6} y={-1.15} width={1.6} height={2.3} rx={0.3} fill={STEEL} />
        <path d="M7.1 -1.25 H9 C10.4 -1.1 10.4 1.1 9 1.25 H7.1 Z" fill={paint} />
      </>
    );
  }
  return (
    <>
      <rect x={0} y={-0.7} width={7.2} height={1.4} rx={0.7} fill="#a8a8a8" />
      <path
        d="M6.6 -2.3 A2.3 2.3 0 1 1 6.6 2.3 L7.4 1 A1 1 0 0 0 7.4 -1 Z"
        fill={STEEL}
      />
    </>
  );
}

/* ---- the status tag --------------------------------------------------- */

export type TagState = "working" | "done" | "note" | null;

/** Claude Code's own spinner, so a working Claude looks like one. */
function Spinner() {
  const frames = AGENTS.claude.spinner;
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % frames.length), 110);
    return () => clearInterval(id);
  }, [frames.length]);
  return <span className="mc-spin">{frames[i]}</span>;
}

function Tag({ state, text, side }: { state: TagState; text: string; side: "top" | "right" }) {
  // Keep the last words while the tag fades out.
  const [shown, setShown] = useState<{ state: TagState; text: string }>({ state, text });
  useEffect(() => {
    if (state) setShown({ state, text });
  }, [state, text]);
  // Keep the tag on screen even when its Claude works right at the edge. It
  // follows a moving Claude, so it checks every frame until it stops moving.
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !state) return;
    let raf = 0;
    let nudge = parseFloat(el.style.marginLeft) || 0;
    let still = 0;
    let last = NaN;
    const tick = () => {
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const left = r.left - nudge;
      const right = r.right - nudge;
      let want = 0;
      if (right > vw - 8) want = vw - 8 - right;
      if (left + want < 8) want = 8 - left;
      if (Math.abs(want - nudge) > 0.5) {
        nudge = want;
        el.style.marginLeft = `${nudge}px`;
      }
      still = Math.abs(left - last) < 0.5 ? still + 1 : 0;
      last = left;
      if (still < 40) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [state, text, side]);

  const s = shown.state;
  return (
    <span
      ref={ref}
      className="mc-tag"
      data-on={state ? "" : undefined}
      data-state={s ?? undefined}
      data-side={side}
    >
      {s === "working" ? <Spinner /> : <span className="mc-spin">{s === "done" ? "✓" : "✻"}</span>}
      <span>{s === "done" ? shown.text || "Done" : shown.text}</span>
    </span>
  );
}

/* ---- the character ---------------------------------------------------- */

/** One observer for every Claude on the page: their loops rest off screen. */
let watcher: IntersectionObserver | null = null;
function watch(el: Element) {
  if (typeof IntersectionObserver === "undefined") return () => {};
  watcher ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) e.target.removeAttribute("data-off");
        else e.target.setAttribute("data-off", "");
      }
    },
    { rootMargin: "120px" },
  );
  watcher.observe(el);
  return () => watcher?.unobserve(el);
}

export function MiniClaude({
  pose = "stand",
  size = "40px",
  hat = false,
  tool,
  paint = BODY,
  face = 1,
  look = [0.5, 0],
  tag = null,
  tagText = "",
  tagSide = "top",
  blink = 0,
  waving = false,
  className = "",
  children,
}: {
  pose?: Pose;
  /** Any CSS length; `em` follows the text it is working on. */
  size?: string;
  hat?: boolean;
  tool?: Tool;
  /** Bristle colour for the brush. */
  paint?: string;
  face?: 1 | -1;
  /** Where the eyes point, in body units (about ±0.6 is the edge). */
  look?: readonly [number, number];
  tag?: TagState;
  tagText?: string;
  /** Above the head, or beside it where above would cover text. */
  tagSide?: "top" | "right";
  /** Offsets the blink so a crew does not blink in unison. */
  blink?: number;
  /** Wave the upper ray, whatever the rest of it is doing. */
  waving?: boolean;
  className?: string;
  /** Rendered in the Claude's own box (a rope, say), behind the tag. */
  children?: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => (ref.current ? watch(ref.current) : undefined), []);

  const rays = hat ? SIDE_RAYS : [...TOP_RAYS, ...SIDE_RAYS];
  const toolPose = pose === "hammer" || pose === "paint" || pose === "wrench";
  const style = {
    "--mc": size,
    "--mc-blink": `${-blink}s`,
  } as CSSProperties;

  return (
    <span
      ref={ref}
      aria-hidden
      className={`mc ${className}`}
      data-pose={pose}
      data-wave={waving ? "" : undefined}
      style={style}
    >
      {children}
      <svg viewBox="-14 -14 28 28">
        <g transform={face === -1 ? "scale(-1 1)" : undefined}>
          <g className="mc-fig">
            <g fill={SHADE}>
              <g className="mc-leg mc-leg-l">
                <path d="M-2 3.8 L-2.3 11.2" stroke={SHADE} strokeWidth={2.1} strokeLinecap="round" />
                <ellipse cx={-2.7} cy={11.7} rx={1.5} ry={0.9} />
              </g>
              <g className="mc-leg mc-leg-r">
                <path d="M2 3.8 L2.3 11.2" stroke={SHADE} strokeWidth={2.1} strokeLinecap="round" />
                <ellipse cx={2.7} cy={11.7} rx={1.5} ry={0.9} />
              </g>
            </g>
            <g fill={BODY}>
              {rays.map(([a, len]) => (
                <g key={a} transform={`rotate(${a})`}>
                  <RayShape len={len} />
                </g>
              ))}
              <g transform={`rotate(${HAND[0]})`}>
                <RayShape len={HAND[1]} />
              </g>
              <g transform={`rotate(${ARM[0]})`}>
                <g className="mc-arm">
                  <RayShape len={ARM[1]} />
                </g>
              </g>
              <circle r={CORE} />
            </g>
            <g className="mc-eyes">
              <g className="mc-look" style={{ translate: `${look[0]}px ${look[1]}px` }}>
                <ellipse cx={-2} cy={-0.3} rx={0.95} ry={1.35} fill="#2a1710" />
                <ellipse cx={2} cy={-0.3} rx={0.95} ry={1.35} fill="#2a1710" />
                <circle cx={-1.7} cy={-0.8} r={0.32} fill="#fff" opacity={0.85} />
                <circle cx={2.3} cy={-0.8} r={0.32} fill="#fff" opacity={0.85} />
              </g>
            </g>
            {hat && (
              <g>
                <path d="M-5.2 -3.4C-5.2 -9.6 5.2 -9.6 5.2 -3.4Z" fill="#e9a23b" />
                <rect x={-6.8} y={-4.1} width={13.6} height={1.7} rx={0.85} fill="#d48f2c" />
                <rect x={-0.75} y={-8.6} width={1.5} height={4.6} rx={0.75} fill="#f6c672" />
              </g>
            )}
            {tool && (
              <g
                transform={`translate(${HAND_TIP.x} ${HAND_TIP.y})`}
                style={{ opacity: toolPose ? 1 : 0, transition: "opacity 200ms" }}
              >
                <g className="mc-tool">
                  <ToolShape tool={tool} paint={paint} />
                </g>
              </g>
            )}
          </g>
        </g>
      </svg>
      <Tag state={tag} text={tagText} side={tagSide} />
    </span>
  );
}
