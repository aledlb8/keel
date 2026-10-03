/**
 * Find, and replace, across the project.
 *
 * Filename search stays on the Files tab. This is the other question — where
 * does this text appear — answered as you type. The field carries its own
 * switches (match case, whole word, regex), the chevron beside it opens a
 * replace field, and the filter button narrows the search to some files or
 * widens it to ignored ones.
 *
 * Results come grouped by file with every match marked. With replace open,
 * each match shows what it would become, and a file or a single line can be
 * replaced on its own. Anything not wanted can be dismissed first, so "Replace
 * all" only touches what is left on screen.
 *
 * Arrow keys walk the results from the field down; Enter opens one with the
 * match selected in the editor, and Delete dismisses it.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  CaseSensitive,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  Copy,
  FileText,
  Files,
  ListFilter,
  Regex,
  Replace,
  ReplaceAll,
  Search,
  SearchX,
  WholeWord,
  X,
} from "lucide-react";

import { FileIcon } from "@/components/inspector/FileIcon";
import { Checkbox } from "@/components/inspector/git/shared";
import { LoadingRows } from "@/components/inspector/LoadingRows";
import { ContextMenuEntries, type MenuEntry } from "@/components/menu/MenuEntries";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { fileName, parentRel } from "@/lib/git";
import { cn } from "@/lib/utils";
import type { GrepHit, GrepOptions } from "@/lib/workspace";
import { useWorkspace } from "@/state/workspace";

const workspace = useWorkspace.getState;

/** How long typing has to pause before a search runs. */
const DEBOUNCE_MS = 180;

interface FileGroup {
  rel: string;
  hits: GrepHit[];
  matches: number;
}

function matchCount(hit: GrepHit): number {
  return hit.ranges?.length || 1;
}

function groupHits(hits: GrepHit[], dismissed: Record<string, true>): FileGroup[] {
  const groups: FileGroup[] = [];
  const index = new Map<string, FileGroup>();
  for (const hit of hits) {
    if (dismissed[hit.rel] || dismissed[`${hit.rel}:${hit.line}`]) continue;
    let group = index.get(hit.rel);
    if (!group) {
      group = { rel: hit.rel, hits: [], matches: 0 };
      index.set(hit.rel, group);
      groups.push(group);
    }
    group.hits.push(hit);
    group.matches += matchCount(hit);
  }
  return groups;
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

/** Move focus to the next or previous result row, from wherever it is now. */
function stepFocus(container: HTMLElement | null, from: Element | null, step: 1 | -1) {
  if (!container) return;
  const rows = [...container.querySelectorAll<HTMLElement>("[data-search-row]")];
  if (rows.length === 0) return;
  const at = from ? rows.indexOf(from as HTMLElement) : -1;
  const next = at === -1 ? (step === 1 ? 0 : rows.length - 1) : at + step;
  if (next < 0) {
    document.querySelector<HTMLInputElement>("[data-grep-query]")?.focus();
    return;
  }
  rows[Math.min(next, rows.length - 1)]?.focus();
}

export function SearchPanel() {
  const root = useWorkspace((state) => state.root);
  const query = useWorkspace((state) => state.grepQuery);
  const options = useWorkspace((state) => state.grepOptions);
  const replaceOpen = useWorkspace((state) => state.grepReplaceOpen);
  const replace = useWorkspace((state) => state.grepReplace);
  const hits = useWorkspace((state) => state.grepHits);
  const truncated = useWorkspace((state) => state.grepTruncated);
  const loading = useWorkspace((state) => state.grepLoading);
  const error = useWorkspace((state) => state.grepError);
  const stats = useWorkspace((state) => state.grepStats);
  const dismissed = useWorkspace((state) => state.grepDismissed);
  const replacing = useWorkspace((state) => state.grepReplacing);
  const [filtersOpen, setFiltersOpen] = useState(
    () => Boolean(options.include || options.exclude || options.includeIgnored),
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const list = useRef<HTMLDivElement | null>(null);

  const needle = query.trim();
  const searching = needle.length >= 2;

  // Search as you type, and again whenever a switch or filter changes.
  useEffect(() => {
    if (!searching) return;
    const timer = window.setTimeout(() => void workspace().grep(query), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, options, searching]);

  // A new replacement only changes the preview, so it can wait a little longer.
  const firstReplace = useRef(true);
  useEffect(() => {
    if (firstReplace.current) {
      firstReplace.current = false;
      return;
    }
    const state = workspace();
    if (!state.grepReplaceOpen || state.grepQuery.trim().length < 2) return;
    const timer = window.setTimeout(() => void workspace().grep(workspace().grepQuery), 260);
    return () => window.clearTimeout(timer);
  }, [replace]);

  // A fresh search starts with every file open.
  useEffect(() => setCollapsed(new Set()), [query, options]);

  const groups = useMemo(() => groupHits(hits ?? [], dismissed), [hits, dismissed]);
  const total = groups.reduce((sum, group) => sum + group.matches, 0);
  const filtering = Boolean(options.include || options.exclude || options.includeIgnored);

  if (!root) return null;

  const fieldKeys = (event: KeyboardEvent<HTMLInputElement>, clear: () => void, value: string) => {
    if (event.key === "Escape" && value) {
      event.preventDefault();
      event.stopPropagation();
      clear();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      stepFocus(list.current, null, 1);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-1 px-[var(--keel-inset)] pb-2">
        <button
          type="button"
          title={replaceOpen ? "Hide replace" : "Replace"}
          aria-label={replaceOpen ? "Hide replace" : "Show replace"}
          aria-expanded={replaceOpen}
          onClick={() => workspace().setGrepReplaceOpen(!replaceOpen)}
          className="k-icon-btn mt-[3px] h-[24px] w-[18px] self-start"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform duration-150", replaceOpen && "rotate-90")}
          />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="k-field gap-1.5 pr-1">
            <Search aria-hidden className="size-3.5 shrink-0" />
            <input
              value={query}
              spellCheck={false}
              placeholder="Search"
              aria-label="Search in files"
              data-grep-query=""
              onChange={(event) => workspace().setGrepQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  workspace().rememberGrep(query);
                  void workspace().grep(query);
                  return;
                }
                fieldKeys(event, () => workspace().setGrepQuery(""), query);
              }}
            />
            <Toggle option="caseSensitive" options={options} label="Match case" icon={<CaseSensitive className="size-3.5" />} />
            <Toggle option="wholeWord" options={options} label="Whole word" icon={<WholeWord className="size-3.5" />} />
            <Toggle option="regex" options={options} label="Regular expression" icon={<Regex className="size-3.5" />} />
          </div>
          {replaceOpen ? (
            <div className="flex gap-1">
              <div className="k-field min-w-0 flex-1 gap-1.5 pr-1">
                <Replace aria-hidden className="size-3.5 shrink-0" />
                <input
                  autoFocus
                  value={replace}
                  spellCheck={false}
                  placeholder={options.regex ? "Replace — $1 for a group" : "Replace"}
                  aria-label="Replace with"
                  onChange={(event) => workspace().setGrepReplace(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void workspace().replaceGrep();
                      return;
                    }
                    fieldKeys(event, () => workspace().setGrepReplace(""), replace);
                  }}
                />
              </div>
              <button
                type="button"
                title="Replace all (Ctrl+Enter)"
                aria-label="Replace all"
                disabled={!groups.length || replacing || loading}
                onClick={() => void workspace().replaceGrep()}
                className="k-icon-btn size-[30px] disabled:opacity-35"
                data-primary="true"
              >
                <ReplaceAll className="size-3.5" />
              </button>
            </div>
          ) : null}
          {filtersOpen ? <Filters options={options} /> : null}
        </div>
      </div>

      {searching || filtering ? (
        <div className="flex h-7 shrink-0 items-center gap-1 px-[calc(var(--keel-inset)+8px)] pb-1">
          <span
            className="min-w-0 flex-1 truncate text-small text-faint"
            aria-live="polite"
            title={stats ? `${plural(stats.files, "file")} searched in ${stats.ms} ms` : undefined}
          >
            {!searching
              ? "Type to search"
              : loading && !hits
                ? "Searching…"
                : error
                  ? "Search failed"
                  : hits
                    ? total
                      ? `${plural(total, "result")} in ${plural(groups.length, "file")}`
                      : hits.length
                        ? "All dismissed"
                        : "No results"
                    : ""}
          </span>
          {loading && hits ? <span className="k-search-pulse" aria-hidden /> : null}
          {Object.keys(dismissed).length && groups.length ? (
            <button
              type="button"
              title="Show dismissed results again"
              onClick={() => workspace().restoreGrep()}
              className="shrink-0 text-small text-faint underline-offset-2 hover:text-dim hover:underline"
            >
              {Object.keys(dismissed).length} dismissed
            </button>
          ) : null}
          <BarButton
            label={filtersOpen ? "Hide file filters" : "Filter files"}
            active={filtering}
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            <ListFilter className="size-3.5" />
          </BarButton>
          {groups.length > 1 ? (
            collapsed.size >= groups.length ? (
              <BarButton label="Expand all" onClick={() => setCollapsed(new Set())}>
                <ChevronsUpDown className="size-3.5" />
              </BarButton>
            ) : (
              <BarButton
                label="Collapse all"
                onClick={() => setCollapsed(new Set(groups.map((group) => group.rel)))}
              >
                <ChevronsDownUp className="size-3.5" />
              </BarButton>
            )
          ) : null}
          {searching ? (
            <BarButton label="Clear search" onClick={() => workspace().setGrepQuery("")}>
              <X className="size-3.5" />
            </BarButton>
          ) : null}
        </div>
      ) : (
        <div className="flex h-7 shrink-0 items-center justify-end px-[calc(var(--keel-inset)+8px)] pb-1">
          <BarButton label="Filter files" active={filtering} onClick={() => setFiltersOpen(!filtersOpen)}>
            <ListFilter className="size-3.5" />
          </BarButton>
        </div>
      )}

      <div
        ref={list}
        role="tree"
        aria-label="Search results"
        className="min-h-0 flex-1 overflow-y-auto pb-3"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            stepFocus(list.current, document.activeElement, event.key === "ArrowDown" ? 1 : -1);
          }
        }}
      >
        {!searching ? (
          <Welcome />
        ) : error ? (
          <Notice icon={SearchX} title="Search failed" detail={error} />
        ) : !hits ? (
          <LoadingRows label="Searching" rows={8} />
        ) : groups.length === 0 && hits.length > 0 ? (
          <Notice
            icon={SearchX}
            title="Everything dismissed"
            detail={`${plural(hits.length, "matching line")} put aside for this search.`}
          >
            <button type="button" className="k-tag mt-3" onClick={() => workspace().restoreGrep()}>
              Show them again
            </button>
          </Notice>
        ) : groups.length === 0 ? (
          <Notice
            icon={SearchX}
            title="No results"
            detail={
              filtering
                ? `Nothing matches “${needle}” in the files the filters allow.`
                : `Nothing in this project matches “${needle}”.`
            }
          />
        ) : (
          <>
            {groups.map((group) => (
              <ResultFile
                key={group.rel}
                group={group}
                replacing={replaceOpen}
                open={!collapsed.has(group.rel)}
                onToggle={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(group.rel)) next.delete(group.rel);
                    else next.add(group.rel);
                    return next;
                  })
                }
              />
            ))}
            {truncated ? (
              <p className="px-[calc(var(--keel-inset)+8px)] pt-2 text-small leading-relaxed text-faint">
                Stopped at {plural(hits.length, "matching line")}. Narrow the search, or filter the
                files, to see the rest.
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// ---- Field furniture ------------------------------------------------------

function Toggle({
  option,
  options,
  label,
  icon,
}: {
  option: "caseSensitive" | "wholeWord" | "regex";
  options: GrepOptions;
  label: string;
  icon: ReactNode;
}) {
  const on = options[option];
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      data-on={on}
      onClick={() => workspace().setGrepOption(option, !on)}
      className="k-search-toggle"
    >
      {icon}
    </button>
  );
}

function BarButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      onClick={onClick}
      className={cn("k-icon-btn relative size-[22px]", active && "text-dim")}
    >
      {children}
      {active ? <span aria-hidden className="k-search-dot" /> : null}
    </button>
  );
}

function Filters({ options }: { options: GrepOptions }) {
  return (
    <div className="flex flex-col gap-1.5">
      <FilterInput
        label="Files to include"
        placeholder="e.g. src, *.ts"
        value={options.include}
        onChange={(value) => workspace().setGrepOption("include", value)}
      />
      <FilterInput
        label="Files to exclude"
        placeholder="e.g. *.test.ts, docs"
        value={options.exclude}
        onChange={(value) => workspace().setGrepOption("exclude", value)}
      />
      <span className="px-0.5">
        <Checkbox
          checked={options.includeIgnored}
          onChange={(on) => workspace().setGrepOption("includeIgnored", on)}
        >
          Also search ignored and build files
        </Checkbox>
      </span>
    </div>
  );
}

/** Typed into freely; the search follows once the typing pauses. */
function FilterInput({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const commit = useRef(onChange);
  commit.current = onChange;
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => commit.current(draft), 350);
    return () => window.clearTimeout(timer);
  }, [draft, value]);
  return (
    <label className="flex flex-col gap-1">
      <span className="px-0.5 text-small text-faint">{label}</span>
      <div className="k-field k-field-sm">
        <input
          value={draft}
          spellCheck={false}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onChange(draft);
            if (event.key === "Escape" && draft) {
              event.preventDefault();
              event.stopPropagation();
              setDraft("");
              onChange("");
            }
          }}
        />
      </div>
    </label>
  );
}

// ---- Empty states ---------------------------------------------------------

function Notice({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: typeof Search;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 pt-8 text-center">
      <span className="grid size-9 place-items-center rounded-[var(--keel-r-control)] bg-veil-2 shadow-[inset_0_1px_0_0_var(--keel-sheen)]">
        <Icon aria-hidden className="size-4 text-dim" />
      </span>
      <p className="mt-3 text-row text-dim">{title}</p>
      <p className="mt-1 max-w-[240px] select-text text-body leading-relaxed text-faint">{detail}</p>
      {children}
    </div>
  );
}

function Welcome() {
  const history = useWorkspace((state) => state.grepHistory);
  if (history.length === 0) {
    return (
      <Notice
        icon={Search}
        title="Search in files"
        detail="Find where text appears across the project. Hidden and ignored files are skipped unless you ask for them."
      />
    );
  }
  return (
    <div className="pt-1">
      <div className="flex items-center px-[calc(var(--keel-inset)+8px)] pb-1">
        <span className="flex-1 text-small font-medium text-faint">Recent</span>
        <button
          type="button"
          onClick={() => workspace().forgetGrepHistory()}
          className="text-small text-faint hover:text-dim"
        >
          Clear
        </button>
      </div>
      {history.map((item) => (
        <button
          key={item}
          type="button"
          data-search-row=""
          className="k-row k-row-dense gap-2"
          onClick={() => {
            workspace().setGrepQuery(item);
            document.querySelector<HTMLInputElement>("[data-grep-query]")?.focus();
          }}
        >
          <Clock aria-hidden className="size-3.5 shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate font-mono text-body text-dim">{item}</span>
        </button>
      ))}
    </div>
  );
}

// ---- Results ----------------------------------------------------------------

function fileMenu(group: FileGroup, replacing: boolean): MenuEntry[] {
  const state = workspace();
  return [
    { kind: "item", label: "Open file", icon: FileText, onSelect: () => void state.openFile(group.rel) },
    ...(replacing
      ? [{ kind: "item" as const, label: "Replace in this file", icon: ReplaceAll, onSelect: () => void state.replaceGrep({ rel: group.rel }) }]
      : []),
    { kind: "separator" },
    { kind: "item", label: "Show in Files", icon: Files, onSelect: () => state.revealInTree(group.rel) },
    { kind: "item", label: "Copy path", icon: Copy, onSelect: () => void navigator.clipboard.writeText(group.rel).catch(() => {}) },
    { kind: "separator" },
    { kind: "item", label: "Dismiss", icon: X, onSelect: () => state.dismissGrep(group.rel) },
  ];
}

function ResultFile({
  group,
  replacing,
  open,
  onToggle,
}: {
  group: FileGroup;
  replacing: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const name = fileName(group.rel);
  const parent = parentRel(group.rel);
  return (
    <div role="group" aria-label={group.rel}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="treeitem"
            aria-expanded={open}
            tabIndex={0}
            data-search-row=""
            title={group.rel}
            className="k-row group/file k-row-dense sticky top-0 z-[1] gap-1.5 bg-[color:var(--keel-chrome)] hover:bg-[color-mix(in_srgb,var(--keel-chrome),white_4%)]"
            onClick={(event) => {
              if (!(event.target as Element).closest("button")) onToggle();
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onToggle();
              } else if (event.key === "ArrowLeft" && open) {
                onToggle();
              } else if (event.key === "ArrowRight" && !open) {
                onToggle();
              } else if (event.key === "Delete") {
                workspace().dismissGrep(group.rel);
              }
            }}
          >
            <ChevronRight
              aria-hidden
              className={cn("size-3 shrink-0 text-faint transition-transform duration-150", open && "rotate-90")}
            />
            <FileIcon name={name} />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="max-w-full shrink-0 truncate text-dim">{name}</span>
              {parent ? <span className="min-w-0 truncate text-small text-faint">{parent}</span> : null}
            </span>
            <span className="hidden shrink-0 items-center gap-px group-hover/file:flex group-focus-visible/file:flex">
              {replacing ? (
                <RowButton label="Replace in this file" onClick={() => void workspace().replaceGrep({ rel: group.rel })}>
                  <ReplaceAll className="size-3" />
                </RowButton>
              ) : null}
              <RowButton label="Dismiss" onClick={() => workspace().dismissGrep(group.rel)}>
                <X className="size-3" />
              </RowButton>
            </span>
            <span className="k-count group-hover/file:hidden group-focus-visible/file:hidden">
              {group.matches}
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuEntries entries={() => fileMenu(group, replacing)} />
        </ContextMenuContent>
      </ContextMenu>
      {open
        ? group.hits.map((hit) => (
            <ResultLine key={`${hit.rel}:${hit.line}`} hit={hit} replacing={replacing} />
          ))
        : null}
    </div>
  );
}

function ResultLine({ hit, replacing }: { hit: GrepHit; replacing: boolean }) {
  const open = () => {
    workspace().rememberGrep(workspace().grepQuery);
    void workspace().openFileAt(hit.rel, hit.line, hit.column, hit.length);
  };
  const dismiss = () => workspace().dismissGrep(`${hit.rel}:${hit.line}`);
  return (
    <div
      role="treeitem"
      tabIndex={0}
      data-search-row=""
      title={`${hit.rel}:${hit.line}:${hit.column}`}
      className="k-row group/hit k-row-dense gap-2 pl-[26px]"
      onClick={(event) => {
        if (!(event.target as Element).closest("button")) open();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        } else if (event.key === "Delete") {
          event.preventDefault();
          // Keep the keyboard in the list: land on the row that takes its place.
          const next = event.currentTarget.nextElementSibling ?? event.currentTarget.previousElementSibling;
          dismiss();
          requestAnimationFrame(() => (next as HTMLElement | null)?.focus());
        }
      }}
    >
      <span className="w-7 shrink-0 text-right font-mono text-micro tabular-nums text-faint">{hit.line}</span>
      <Preview hit={hit} replacing={replacing} />
      <span className="hidden shrink-0 items-center gap-px group-hover/hit:flex group-focus-visible/hit:flex">
        {replacing ? (
          <RowButton label="Replace this line" onClick={() => void workspace().replaceGrep({ rel: hit.rel, line: hit.line })}>
            <Replace className="size-3" />
          </RowButton>
        ) : null}
        <RowButton label="Dismiss" onClick={dismiss}>
          <X className="size-3" />
        </RowButton>
      </span>
    </div>
  );
}

/**
 * The line with its matches marked. With replace open, each match is struck
 * through and followed by what it becomes.
 */
/** Characters of context kept ahead of the first match in a narrow dock. */
const LEAD = 10;

/**
 * The line with its matches marked. With replace open, each match is struck
 * through and followed by what it becomes. A dock is narrow, so a line whose
 * first match sits far in is cut to start just before it.
 */
function Preview({ hit, replacing }: { hit: GrepHit; replacing: boolean }) {
  const first = hit.ranges?.[0]?.[0] ?? 0;
  // Replacing shows the old text and the new side by side, so it needs the room.
  const lead = replacing ? 4 : LEAD;
  const cut = first > lead + 4 ? first - lead : 0;
  const text = cut ? `…${hit.text.slice(cut)}` : hit.text;
  const shift = cut ? 1 - cut : 0;
  const ranges = (hit.ranges ?? []).map(([start, end]) => [start + shift, end + shift] as const);
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], index) => {
    if (start > at) parts.push(text.slice(at, start));
    const matched = text.slice(start, end);
    const becomes = replacing ? hit.replacements?.[index] : undefined;
    if (becomes !== undefined) {
      if (matched) parts.push(<del key={`d${index}`} className="k-search-del">{matched}</del>);
      if (becomes) parts.push(<ins key={`i${index}`} className="k-search-ins">{becomes}</ins>);
    } else {
      parts.push(<mark key={`m${index}`} className="k-search-mark">{matched}</mark>);
    }
    at = Math.max(at, end);
  });
  if (at < text.length) parts.push(text.slice(at));
  return (
    <span
      title={hit.text}
      className="min-w-0 flex-1 truncate whitespace-pre font-mono text-body text-dim"
    >
      {parts.length ? parts : text}
    </span>
  );
}

function RowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="k-icon-btn size-[22px]"
    >
      {children}
    </button>
  );
}
