import type { ReactNode } from "react";

export const REPO = "https://github.com/aledlb8/keel";
export const RELEASES = `${REPO}/releases/latest`;

export function Kbd({ children, lit = false }: { children: ReactNode; lit?: boolean }) {
  return (
    <kbd
      className={`inline-flex h-7 min-w-7 items-center justify-center rounded-[7px] px-2 font-sans text-[13px] font-medium transition-all duration-150 ${
        lit
          ? "translate-y-[1px] bg-ink text-black shadow-[0_1px_0_0_#9a9a9a,0_0_24px_rgba(255,255,255,0.25)]"
          : "bg-[linear-gradient(#262626,#1a1a1a)] text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_2px_0_0_#050505,0_0_0_1px_rgba(255,255,255,0.06)]"
      }`}
    >
      {children}
    </kbd>
  );
}

export function GithubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 3.35.95.1-.74.4-1.25.73-1.54-2.56-.29-5.25-1.28-5.25-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.7 5.38-5.27 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

export function Container({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`mx-auto w-full max-w-[1320px] px-4 sm:px-8 ${className}`}>{children}</div>;
}

/** Section headings: the display face, one step down from the hero. */
export function Heading({
  children,
  className = "",
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <h2
      id={id}
      className={`text-balance text-[clamp(2.25rem,5.2vw,4.5rem)] leading-[0.95] font-[800] tracking-[-0.035em] [font-stretch:118%] ${className}`}
    >
      {children}
    </h2>
  );
}
