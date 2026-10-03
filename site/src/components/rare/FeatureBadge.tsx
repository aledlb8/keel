import type { ReactNode } from "react";

/*
 * Adapted from RareUI's FeatureBadge (MIT, see ./LICENSE). The glare is a CSS
 * sweep rather than a motion loop, so it costs nothing and stops for reduced
 * motion along with everything else.
 */
export function FeatureBadge({
  badge,
  children,
  href,
  className = "",
}: {
  badge: ReactNode;
  children: ReactNode;
  href: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      className={`group relative inline-flex items-center gap-2.5 overflow-hidden rounded-full py-1 pr-3.5 pl-1 text-[14px] text-dim shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_1px_rgba(255,255,255,0.09)] backdrop-blur-md transition-[background-color,color,box-shadow] duration-300 bg-white/[0.04] hover:bg-white/[0.07] hover:text-ink hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_0_0_1px_rgba(255,255,255,0.16)] ${className}`}
    >
      <span aria-hidden className="glare pointer-events-none absolute inset-y-0 left-0 w-1/2" />
      <span className="relative rounded-full bg-ink px-2.5 py-0.5 text-[12px] font-bold tracking-tight text-black">
        {badge}
      </span>
      <span className="relative">{children}</span>
      <span
        aria-hidden
        className="relative text-faint transition-transform duration-300 ease-keel group-hover:translate-x-0.5 group-hover:text-ink"
      >
        →
      </span>
    </a>
  );
}
