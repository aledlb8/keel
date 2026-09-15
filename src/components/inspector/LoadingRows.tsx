/** Shared loading placeholder for Git lists and editor contents. */
export function LoadingRows({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="space-y-2 px-3 py-2">
      <span className="sr-only">{label}</span>
      <div aria-hidden className="space-y-2 motion-safe:animate-pulse">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex h-5 items-center gap-2">
            <span className="size-3.5 shrink-0 rounded bg-veil" />
            <span className="h-2.5 rounded bg-veil" style={{ width: `${[72, 48, 62, 38][index % 4]}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
