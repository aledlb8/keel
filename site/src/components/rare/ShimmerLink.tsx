import type { ReactNode } from "react";

/*
 * Adapted from RareUI's GlassShimmerButton (MIT, see ./LICENSE). It is a link
 * here, not a button, and the glass is Keel's: a light face graded top to
 * bottom so a white band crossing it actually reads, one hairline of gloss
 * along the top, and no hue anywhere.
 */
export function ShimmerLink({
  href,
  children,
  size = "lg",
  className = "",
}: {
  href: string;
  children: ReactNode;
  size?: "sm" | "lg";
  className?: string;
}) {
  const box =
    size === "lg"
      ? "h-12 rounded-[11px] px-6 text-[16px] shadow-[0_10px_40px_-10px_rgba(255,255,255,0.35)] hover:shadow-[0_16px_50px_-12px_rgba(255,255,255,0.55)]"
      : "h-9 rounded-[10px] px-4 text-[14px] shadow-[0_6px_24px_-10px_rgba(255,255,255,0.4)]";
  return (
    <a
      href={href}
      className={`group relative isolate inline-flex shrink-0 items-center justify-center overflow-hidden font-semibold whitespace-nowrap text-black transition-[transform,box-shadow,filter] duration-300 ease-keel [background:linear-gradient(180deg,#fbfbfb,#d6d6d6)] hover:-translate-y-px hover:brightness-105 active:translate-y-0 active:scale-[0.98] ${box} ${className}`}
    >
      <span aria-hidden className="shimmer pointer-events-none absolute inset-y-0 left-0 w-1/3" />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,#fff,transparent)]"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-[linear-gradient(90deg,transparent,rgba(0,0,0,0.18),transparent)]"
      />
      <span className="relative">{children}</span>
    </a>
  );
}
