"use client";

import { useEffect, useState } from "react";

import { Container, Heading, Kbd } from "./ui";

type Combo = { keys: string[]; match: (e: KeyboardEvent) => boolean };

const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;
const key = (e: KeyboardEvent, k: string) => e.key.toLowerCase() === k;

const SHORTCUTS: { action: string; combos: Combo[] }[] = [
  { action: "Go to a terminal, deck or action", combos: [{ keys: ["Ctrl", "P"], match: (e) => mod(e) && !e.shiftKey && key(e, "p") }] },
  { action: "Focus the next waiting agent", combos: [{ keys: ["F8"], match: (e) => e.key === "F8" }] },
  { action: "Add terminals", combos: [{ keys: ["Ctrl", "T"], match: (e) => mod(e) && key(e, "t") }] },
  { action: "Open the deck overview", combos: [{ keys: ["Ctrl", "O"], match: (e) => mod(e) && key(e, "o") }] },
  { action: "Jump to a deck", combos: [{ keys: ["Ctrl", "1…9"], match: (e) => mod(e) && /^[1-9]$/.test(e.key) }] },
  { action: "Create a deck", combos: [{ keys: ["Ctrl", "N"], match: (e) => mod(e) && key(e, "n") }] },
  { action: "Find in files", combos: [{ keys: ["Ctrl", "Shift", "F"], match: (e) => mod(e) && e.shiftKey && key(e, "f") }] },
  {
    action: "Split right, split down",
    combos: [
      { keys: ["Ctrl", "Shift", "D"], match: (e) => mod(e) && e.shiftKey && key(e, "d") },
      { keys: ["Ctrl", "Shift", "S"], match: (e) => mod(e) && e.shiftKey && key(e, "s") },
    ],
  },
  { action: "Focus the next pane", combos: [{ keys: ["Ctrl", "Tab"], match: (e) => mod(e) && e.key === "Tab" }] },
  { action: "Fullscreen the focused pane", combos: [{ keys: ["F11"], match: (e) => e.key === "F11" }] },
  { action: "Close the focused pane", combos: [{ keys: ["Ctrl", "W"], match: (e) => mod(e) && key(e, "w") }] },
  { action: "Rename the focused item", combos: [{ keys: ["F2"], match: (e) => e.key === "F2" }] },
];

export function Keys() {
  const [lit, setLit] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea")) return;
      for (const s of SHORTCUTS) {
        s.combos.forEach((c, i) => {
          if (c.match(e)) {
            setLit(`${s.action}:${i}`);
            clearTimeout(timer);
            timer = setTimeout(() => setLit(null), 700);
          }
        });
      }
    };
    window.addEventListener("keydown", on);
    return () => {
      window.removeEventListener("keydown", on);
      clearTimeout(timer);
    };
  }, []);

  return (
    <section id="keys" className="relative py-24 sm:py-36">
      <Container>
        <div className="grid gap-10 md:grid-cols-12">
          <Heading className="md:col-span-7">Every move has a key.</Heading>
          <p className="max-w-[30rem] text-[18px] leading-[1.65] text-dim md:col-span-5 md:self-end">
            Most of the work happens from the keyboard, so focus is always
            visible and every action is a keystroke away. Press one. The ones
            your browser lets through light up.
          </p>
        </div>

        <div className="mt-16 grid gap-x-16 md:grid-cols-2 lg:mt-24">
          {SHORTCUTS.map((s) => {
            const active = lit?.startsWith(`${s.action}:`);
            return (
              <div
                key={s.action}
                className={`flex items-center justify-between gap-6 border-t border-white/[0.07] py-5 transition-colors duration-300 ${active ? "text-ink" : "text-dim"}`}
              >
                <span className="text-[16px]">{s.action}</span>
                <span className="flex shrink-0 items-center gap-3">
                  {s.combos.map((c, i) => (
                    <span key={i} className="flex items-center gap-1.5">
                      {c.keys.map((k) => (
                        <Kbd key={k} lit={lit === `${s.action}:${i}`}>
                          {k}
                        </Kbd>
                      ))}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
      </Container>
    </section>
  );
}
