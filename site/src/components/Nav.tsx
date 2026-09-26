"use client";

import { useEffect, useState } from "react";

import { KeelMark } from "./marks";
import { GithubIcon, RELEASES, REPO } from "./ui";

const LINKS = [
  ["Demo", "#demo"],
  ["Agents", "#agents"],
  ["Layout", "#layout"],
  ["Features", "#features"],
  ["Keys", "#keys"],
] as const;

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-[background-color,box-shadow,backdrop-filter] duration-300 ${
        scrolled
          ? "bg-ground/75 shadow-[0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl"
          : "bg-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 w-full max-w-[1320px] items-center gap-8 px-4 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5 text-ink" aria-label="Keel, back to top">
          <KeelMark size={20} />
          <span className="text-[19px] font-[800] tracking-[-0.02em] [font-stretch:120%]">Keel</span>
        </a>
        <div className="hidden items-center gap-7 text-[14px] text-dim md:flex">
          {LINKS.map(([label, href]) => (
            <a key={href} href={href} className="transition-colors hover:text-ink">
              {label}
            </a>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <a
            href={REPO}
            className="hidden h-9 items-center gap-2 rounded-[9px] px-3 text-[14px] text-dim transition-colors hover:bg-veil-2 hover:text-ink sm:flex"
          >
            <GithubIcon size={16} />
            Source
          </a>
          <a
            href={RELEASES}
            className="flex h-9 items-center rounded-[9px] bg-ink px-4 text-[14px] font-semibold text-black transition-colors hover:bg-white"
          >
            Download
          </a>
        </div>
      </nav>
    </header>
  );
}
