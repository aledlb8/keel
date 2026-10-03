/**
 * The body of a tab whose file is not text: a viewer picked by what the file
 * is — an image, a video, a song, a PDF, a font, a database — or its bytes.
 *
 * Media streams from the `keel-file` scheme, so nothing here holds a copy of
 * the file. Every URL carries the file's mtime: when it changes on disk the
 * tab re-reads it, the URL changes with it, and the viewer shows the new one.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { FileWarning, Music } from "lucide-react";

import { DockNotice } from "@/components/Dock";
import { HexView } from "@/components/editor/HexView";
import { SqliteView } from "@/components/editor/SqliteView";
import { fileName } from "@/lib/git";
import { previewUrl, type PreviewKind } from "@/lib/preview";
import type { FileContents } from "@/lib/workspace";
import { cn } from "@/lib/utils";

const SCHEME = "keel-file";

export interface FilePreviewProps {
  root: string;
  rel: string;
  kind: PreviewKind;
  snapshot: FileContents;
  /** The viewer could not show it: offer its bytes instead. */
  onShowBytes: () => void;
  onOpenExternally: () => void;
}

export function FilePreview({
  root,
  rel,
  kind,
  snapshot,
  onShowBytes,
  onOpenExternally,
}: FilePreviewProps) {
  const [failed, setFailed] = useState(false);
  const src = previewUrl(convertFileSrc("", SCHEME), root, rel, snapshot.mtimeMs);
  const name = fileName(rel);

  // A new version of the file deserves another try.
  useEffect(() => setFailed(false), [src, kind]);

  if (failed) {
    return (
      <DockNotice
        icon={FileWarning}
        title="Keel can't show this file"
        detail="Its format isn't one this viewer plays. Look at its bytes, or open it in its own app."
        className="h-full justify-center"
      >
        <div className="mt-3 flex gap-1.5">
          <button type="button" className="k-tag" onClick={onShowBytes}>
            View bytes
          </button>
          <button type="button" className="k-tag" onClick={onOpenExternally}>
            Open in default app
          </button>
        </div>
      </DockNotice>
    );
  }

  const fail = () => setFailed(true);
  switch (kind) {
    case "image":
      return <ImageView src={src} name={name} onError={fail} />;
    case "video":
      return (
        <Stage className="bg-black/40">
          <video
            key={src}
            src={src}
            controls
            preload="metadata"
            onError={fail}
            className="max-h-full max-w-full outline-none"
          />
        </Stage>
      );
    case "audio":
      return (
        <Stage>
          <div className="flex w-full max-w-md flex-col items-center gap-4">
            <span className="grid size-16 place-items-center rounded-[var(--keel-r-window)] bg-veil-2 shadow-[inset_0_1px_0_0_var(--keel-sheen)]">
              <Music aria-hidden className="size-6 text-dim" />
            </span>
            <p className="max-w-full truncate text-row text-dim">{name}</p>
            <audio
              key={src}
              src={src}
              controls
              preload="metadata"
              onError={fail}
              className="w-full"
            />
          </div>
        </Stage>
      );
    case "pdf":
      return (
        <iframe
          key={src}
          src={src}
          title={name}
          className="block h-full w-full border-0 bg-[color:var(--keel-term-solid)]"
        />
      );
    case "font":
      return <FontView src={src} onError={fail} />;
    case "sqlite":
      return <SqliteView root={root} rel={rel} version={snapshot.mtimeMs} />;
    case "hex":
      return (
        <HexView key={src} root={root} rel={rel} size={snapshot.size} />
      );
  }
}

/** A centred, padded field for one thing to look at. */
function Stage({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("grid h-full place-items-center overflow-hidden p-4", className)}>
      {children}
    </div>
  );
}

/**
 * An image, fitted to the pane. One that is larger than the pane opens at its
 * real size on a click and scrolls; another click fits it again. It sits on a
 * checkerboard so transparency reads as transparency.
 */
function ImageView({
  src,
  name,
  onError,
}: {
  src: string;
  name: string;
  onError: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null);
  const [actual, setActual] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setRoom({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Padding on both sides: the image only fits inside it.
  const PAD = 32;
  const larger = Boolean(
    natural &&
      room &&
      (natural.width > room.width - PAD || natural.height > room.height - PAD),
  );
  const zoomed = actual && larger;

  return (
    <div className="relative h-full">
      <div ref={host} className="k-checker h-full overflow-auto">
        <div
          className={cn(
            "grid place-items-center p-4",
            zoomed ? "min-h-full min-w-max" : "h-full",
          )}
        >
          <img
            key={src}
            src={src}
            alt={name}
            draggable={false}
            onLoad={(event) => {
              const img = event.currentTarget;
              setNatural({ width: img.naturalWidth, height: img.naturalHeight });
            }}
            onError={onError}
            onClick={() => {
              if (larger) setActual((value) => !value);
            }}
            className={cn(
              "block select-none",
              zoomed ? "max-w-none" : "max-h-full max-w-full object-contain",
              larger && (zoomed ? "cursor-zoom-out" : "cursor-zoom-in"),
            )}
          />
        </div>
      </div>
      {natural ? (
        <span className="k-tag pointer-events-none absolute bottom-2 right-3 font-mono tabular-nums">
          {natural.width} × {natural.height}
          {larger ? ` · ${zoomed ? "100%" : "fitted"}` : ""}
        </span>
      ) : null}
    </div>
  );
}

const GLYPHS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 !@#$%&*()[]{}<>?/\\|+-=_.,:;'\"`~";
const SIZES = [12, 16, 24, 36, 56];

/** A font, set in a line you can rewrite, at a ladder of sizes. */
function FontView({ src, onError }: { src: string; onError: () => void }) {
  const [family, setFamily] = useState<string | null>(null);
  const [sample, setSample] = useState("The quick brown fox jumps over the lazy dog");

  useEffect(() => {
    let cancelled = false;
    const name = `keel-preview-${Math.random().toString(36).slice(2)}`;
    const face = new FontFace(name, `url("${src}")`);
    face.load().then(
      (loaded) => {
        if (cancelled) return;
        document.fonts.add(loaded);
        setFamily(name);
      },
      () => {
        if (!cancelled) onError();
      },
    );
    return () => {
      cancelled = true;
      document.fonts.delete(face);
    };
    // `onError` is a fresh closure each render; the font only follows `src`.
  }, [src]);

  if (!family) return null;
  const style = { fontFamily: `"${family}"` };
  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="sticky top-0 z-10 border-b border-[color:var(--keel-term-border)] bg-[color:var(--keel-term-solid)] p-2">
        <label className="k-field k-field-sm">
          <span className="sr-only">Sample text</span>
          <input
            value={sample}
            onChange={(event) => setSample(event.target.value)}
            placeholder="Type a sample"
            spellCheck={false}
          />
        </label>
      </div>
      <div className="flex flex-col gap-5 px-5 py-4 text-foreground">
        {SIZES.map((size) => (
          <div key={size} className="flex min-w-0 items-baseline gap-4">
            <span className="w-8 shrink-0 text-right font-mono text-micro text-faint tabular-nums">
              {size}
            </span>
            <p className="min-w-0 break-words leading-tight" style={{ ...style, fontSize: size }}>
              {sample || " "}
            </p>
          </div>
        ))}
        <p
          className="mt-2 break-all pl-12 text-[22px] leading-relaxed text-dim"
          style={style}
        >
          {GLYPHS}
        </p>
      </div>
    </div>
  );
}
