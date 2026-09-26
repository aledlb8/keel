"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { KeelMark } from "./marks";
import { Container, GithubIcon, RELEASES, REPO } from "./ui";

const STEPS = [
  "git clone https://github.com/aledlb8/keel",
  "cd keel",
  "pnpm install",
  "pnpm dev",
];

function Source() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="sheen relative overflow-hidden rounded-[16px] bg-chrome shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
      <div className="flex h-11 items-center gap-2 px-4 text-[13px] text-faint">
        <span>Build from source</span>
        <span className="text-white/15">/</span>
        <span>Node 22, pnpm 11, Rust</span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(STEPS.join("\n")).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            });
          }}
          className="ml-auto flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-dim transition-colors hover:bg-veil-2 hover:text-ink"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto bg-slab px-5 py-5 font-mono text-[14px] leading-[1.9]">
        {STEPS.map((s) => (
          <div key={s}>
            <span className="text-faint select-none">❯ </span>
            <span className="text-ink">{s}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

export function Closing() {
  return (
    <section className="relative overflow-hidden pt-24 sm:pt-36">
      <Container>
        <div className="grid gap-14 lg:grid-cols-12 lg:items-end">
          <div className="min-w-0 lg:col-span-7">
            <h2 className="display text-[clamp(2.4rem,7vw,6.5rem)] text-balance">
              Put every agent where you can see it.
            </h2>
            <p className="mt-8 max-w-[32rem] text-[18px] leading-[1.65] text-dim">
              Keel is free and open source under the MIT license. Download a
              release, or build it yourself in four commands.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <a
                href={RELEASES}
                className="flex h-12 items-center rounded-[11px] bg-ink px-6 text-[16px] font-semibold text-black shadow-[0_10px_40px_-10px_rgba(255,255,255,0.35)] transition-[background-color,transform] hover:-translate-y-px hover:bg-white"
              >
                Download Keel
              </a>
              <a
                href={REPO}
                className="flex h-12 items-center gap-2.5 rounded-[11px] px-5 text-[16px] text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] transition-colors hover:bg-veil-2"
              >
                <GithubIcon size={18} />
                Star on GitHub
              </a>
            </div>
          </div>
          <div className="min-w-0 lg:col-span-5">
            <Source />
          </div>
        </div>

        <footer className="mt-32 flex flex-col gap-4 border-t border-white/[0.07] pt-8 text-[14px] text-faint sm:flex-row sm:items-center">
          <span className="flex items-center gap-2 text-dim">
            <KeelMark size={14} />
            Keel
          </span>
          <span>Built with Tauri 2, Rust, React and xterm.js.</span>
          <span className="flex gap-6 sm:ml-auto">
            <a className="hover:text-ink" href={REPO}>GitHub</a>
            <a className="hover:text-ink" href={`${REPO}/blob/main/LICENSE`}>MIT license</a>
            <a className="hover:text-ink" href={`${REPO}/blob/main/SECURITY.md`}>Security</a>
          </span>
        </footer>
      </Container>

      {/* The wordmark, sitting low like a hull below the waterline. */}
      <div aria-hidden className="pointer-events-none relative mt-10 h-[17vw] select-none">
        <span
          className="display absolute inset-x-0 top-0 block text-center text-[31vw] leading-[0.8] text-transparent"
          style={{
            backgroundImage: "linear-gradient(180deg, #202020 0%, #111 38%, rgba(5,5,5,0) 62%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
          }}
        >
          Keel
        </span>
      </div>
    </section>
  );
}
