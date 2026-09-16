/**
 * Project-wide content search: every match, grouped by file.
 *
 * Filename search stays on the Files tab. This is the other question — where
 * does this text appear — and a click jumps to that line in the editor.
 */

import { useEffect } from "react";
import { Regex, Search, SearchX } from "lucide-react";

import { DockNotice } from "@/components/Dock";
import { FileIcon } from "@/components/inspector/FileIcon";
import { fileName, parentRel } from "@/lib/git";
import { cn } from "@/lib/utils";
import type { GrepHit } from "@/lib/workspace";
import { useWorkspace } from "@/state/workspace";

function groupHits(hits: GrepHit[]): { rel: string; hits: GrepHit[] }[] {
  const groups: { rel: string; hits: GrepHit[] }[] = [];
  const index = new Map<string, number>();
  for (const hit of hits) {
    const existing = index.get(hit.rel);
    if (existing === undefined) {
      index.set(hit.rel, groups.length);
      groups.push({ rel: hit.rel, hits: [hit] });
    } else {
      groups[existing].hits.push(hit);
    }
  }
  return groups;
}

export function SearchPanel() {
  const root = useWorkspace((state) => state.root);
  const grepQuery = useWorkspace((state) => state.grepQuery);
  const grepRegex = useWorkspace((state) => state.grepRegex);
  const grepHits = useWorkspace((state) => state.grepHits);
  const grepTruncated = useWorkspace((state) => state.grepTruncated);
  const grepLoading = useWorkspace((state) => state.grepLoading);
  const grepError = useWorkspace((state) => state.grepError);
  const setGrepQuery = useWorkspace((state) => state.setGrepQuery);
  const setGrepRegex = useWorkspace((state) => state.setGrepRegex);

  useEffect(() => {
    const needle = grepQuery.trim();
    if (needle.length < 2) return;
    const timer = window.setTimeout(() => {
      void useWorkspace.getState().grep(grepQuery);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [grepQuery, grepRegex]);

  if (!root) return null;

  const needle = grepQuery.trim();
  const searching = needle.length >= 2;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 px-[var(--keel-inset)] pb-2">
        <div className="k-field min-w-0 flex-1">
          <Search aria-hidden className="size-3.5 shrink-0" />
          <input
            value={grepQuery}
            spellCheck={false}
            placeholder="Search in files"
            aria-label="Search in files"
            data-grep-query=""
            onChange={(event) => setGrepQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && grepQuery) {
                event.preventDefault();
                setGrepQuery("");
              }
            }}
          />
        </div>
        <button
          type="button"
          title="Regular expression"
          aria-label="Regular expression"
          aria-pressed={grepRegex}
          onClick={() => setGrepRegex(!grepRegex)}
          className={cn("k-icon-btn size-[28px]", grepRegex && "text-dim")}
        >
          <Regex className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!searching ? (
          <DockNotice
            icon={Search}
            title="Search in files"
            detail="Type at least two characters to search the project."
            className="pt-8"
          />
        ) : grepHits && grepHits.length > 0 ? (
          <>
            {groupHits(grepHits).map((group) => (
              <FileGroup key={group.rel} rel={group.rel} hits={group.hits} />
            ))}
            {grepTruncated ? (
              <p className="px-[var(--keel-inset)] py-2 text-[11px] text-faint">
                Showing the first 500 matches
              </p>
            ) : null}
          </>
        ) : grepLoading ? (
          <p className="px-[var(--keel-inset)] py-2 text-[12px] text-faint">Searching…</p>
        ) : grepError ? (
          <DockNotice
            icon={SearchX}
            title="Search failed"
            detail={grepError}
            className="pt-8"
          />
        ) : grepHits ? (
          <DockNotice
            icon={SearchX}
            title="No matches"
            detail={`Nothing in this project matches “${needle}”.`}
            className="pt-8"
          />
        ) : null}
      </div>
    </div>
  );
}

function FileGroup({ rel, hits }: { rel: string; hits: GrepHit[] }) {
  const name = fileName(rel);
  const parent = parentRel(rel);
  return (
    <div className="mb-0.5">
      <div className="k-row h-[28px] gap-2" title={rel}>
        <FileIcon name={name} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="max-w-full shrink-0 truncate text-dim">{name}</span>
          {parent ? (
            <span className="min-w-0 truncate text-[11px] text-faint">{parent}</span>
          ) : null}
        </span>
      </div>
      {hits.map((hit) => (
        <HitRow key={`${hit.rel}:${hit.line}:${hit.column}`} hit={hit} />
      ))}
    </div>
  );
}

function HitRow({ hit }: { hit: GrepHit }) {
  const activate = () => {
    void useWorkspace.getState().openFileAt(hit.rel, hit.line, hit.column);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      title={`${hit.rel}:${hit.line}`}
      className="k-row h-[28px] gap-2"
      onClick={activate}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
    >
      <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-faint">
        {hit.line}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-dim">
        {hit.text}
      </span>
    </div>
  );
}
