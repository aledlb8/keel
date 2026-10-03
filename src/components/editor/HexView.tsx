/**
 * Any file as bytes: offset, sixteen bytes in hex, the same bytes as ASCII.
 *
 * It reads a slice at a time and adds the next on request, so a gigabyte file
 * opens as fast as a small one and only costs what you scroll through.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { LoadingRows } from "@/components/inspector/LoadingRows";
import {
  errorMessage,
  formatBytes,
  hexRows,
  workspaceReadBytes,
  type HexRow,
} from "@/lib/preview";

const SLICE = 64 * 1024;

export function HexView({ root, rel, size }: { root: string; rel: string; size: number }) {
  const [rows, setRows] = useState<HexRow[]>([]);
  const [loaded, setLoaded] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);

  const more = useCallback(
    async (from: number) => {
      if (reading.current) return;
      reading.current = true;
      setBusy(true);
      try {
        const buffer = await workspaceReadBytes(root, rel, from, SLICE);
        const bytes = new Uint8Array(buffer);
        setRows((current) => [...current, ...hexRows(bytes, from)]);
        setLoaded(from + bytes.length);
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        reading.current = false;
        setBusy(false);
      }
    },
    [root, rel],
  );

  useEffect(() => {
    void more(0);
  }, [more]);

  if (rows.length === 0 && busy) return <LoadingRows label="Reading bytes" rows={12} />;
  if (size === 0) {
    return <p className="p-4 text-body text-faint">This file is empty.</p>;
  }

  const left = Math.max(0, size - loaded);
  return (
    <div className="h-full overflow-auto">
      <div className="min-w-max py-2 font-mono text-small leading-[18px]">
        {rows.map((row) => (
          <div key={row.offset} className="flex gap-5 px-3 hover:bg-veil">
            <span className="select-none text-faint">{row.offset}</span>
            <span className="whitespace-pre text-[color:var(--keel-term-fg)]">{row.hex}</span>
            <span className="whitespace-pre text-dim">{row.ascii}</span>
          </div>
        ))}
        <div className="flex items-center gap-2 px-3 pb-2 pt-3 font-sans text-small text-faint">
          {error ? (
            <span className="text-[color:var(--keel-dead)]">{error}</span>
          ) : (
            <span>
              {formatBytes(loaded)} of {formatBytes(size)}
            </span>
          )}
          {left > 0 ? (
            <button
              type="button"
              className="k-tag"
              disabled={busy}
              onClick={() => void more(loaded)}
            >
              {busy ? "Reading…" : `Show the next ${formatBytes(Math.min(SLICE, left))}`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
