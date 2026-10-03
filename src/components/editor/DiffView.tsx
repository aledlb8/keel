/**
 * One git change, read the way a code review reads it.
 *
 * The code keeps its own syntax colour; the ground under a line says what
 * happened to it, and inside a line that was edited rather than replaced, the
 * words that changed are lit a step brighter. It reads inline or side by
 * side, with as much unchanged code around each change as you ask for.
 *
 * A change in the working tree or the index can be taken apart here: each
 * hunk stages, unstages or discards on its own, and clicking the line numbers
 * picks single lines (shift-click for a run) to do the same to just those.
 * The view follows the file — stage a line and it moves across, edit the file
 * and the diff redraws.
 *
 * F7 and Shift+F7, or Alt+↓ and Alt+↑, step from change to change.
 */

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  FileDiff,
  Minus,
  Plus,
  Rows3,
  Undo2,
  X,
} from "lucide-react";

import { DockNotice } from "@/components/Dock";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  changeStarts,
  hiddenBefore,
  pairLines,
  segments,
  splitRows,
  wordDiff,
  type Range,
  type StyledSpan,
} from "@/lib/diffView";
import { splitHunkHeader } from "@/lib/git";
import { ask } from "@/lib/ask";
import { cn } from "@/lib/utils";
import { FULL_CONTEXT, type DiffLine, type GitDiff, type LineAction, type LineSelection } from "@/lib/workspace";
import { useWorkspace, type EditorTab } from "@/state/workspace";

import { highlightHunks, syntaxStyle } from "./diffSyntax";

const workspace = useWorkspace.getState;

const CONTEXT_CHOICES = [
  { value: 3, label: "3 lines of context" },
  { value: 10, label: "10 lines of context" },
  { value: FULL_CONTEXT, label: "Whole file" },
];

const key = (hunk: number, line: number) => `${hunk}:${line}`;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function DiffView({ id }: { id: string }) {
  const diff = useWorkspace((state) => state.diffs[id]);
  const tab = useWorkspace((state) => state.editors.find((item) => item.id === id));
  const git = useWorkspace((state) => state.git);

  // Follow the file: a status change means the diff on screen may be stale.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (tab && !tab.rev) void workspace().refreshDiff(id);
  }, [git, id, tab]);

  if (!diff || !tab) return null;

  if (diff.binary) {
    return (
      <DockNotice
        icon={FileDiff}
        title="Binary file"
        detail="Git can't show a line-by-line diff for this file."
        className="h-full justify-center"
      />
    );
  }

  if (diff.hunks.length === 0) {
    return (
      <DockNotice
        icon={FileDiff}
        title="No changes"
        detail={
          tab.staged
            ? "Nothing of this file is staged any more."
            : "Nothing here differs any more."
        }
        className="h-full justify-center"
      />
    );
  }

  const file = git?.files.find((item) => item.path === tab.rel);
  // Lines can be moved only within a tracked text file git can patch.
  const editable = !tab.rev && Boolean(file) && !file?.untracked && !file?.conflict;
  return <DiffBody id={id} diff={diff} tab={tab} editable={editable} />;
}

function DiffBody({
  id,
  diff,
  tab,
  editable,
}: {
  id: string;
  diff: GitDiff;
  tab: EditorTab;
  editable: boolean;
}) {
  const layout = useWorkspace((state) => state.diffLayout);
  const context = useWorkspace((state) => state.diffContext);
  const busy = useWorkspace((state) => state.busy);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [current, setCurrent] = useState<number | null>(null);
  const anchor = useRef<{ hunk: number; line: number } | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  const syntax = useMemo(() => highlightHunks(tab.rel, diff.hunks), [tab.rel, diff]);
  const words = useMemo(() => {
    const ranges = new Map<string, Range[]>();
    diff.hunks.forEach((hunk, h) => {
      for (const [from, to] of pairLines(hunk.lines)) {
        const line = hunk.lines[from]!;
        if (line.kind !== "del") continue;
        const result = wordDiff(line.text, hunk.lines[to]!.text);
        if (!result) continue;
        ranges.set(key(h, from), result.removed);
        ranges.set(key(h, to), result.added);
      }
    });
    return ranges;
  }, [diff]);
  const starts = useMemo(() => changeStarts(diff.hunks), [diff]);
  const startIndex = useMemo(
    () => new Map(starts.map((start, index) => [key(start.hunk, start.line), index])),
    [starts],
  );

  // A redrawn diff has new line numbers; whatever was picked no longer holds.
  useEffect(() => {
    setSelection(new Set());
    anchor.current = null;
  }, [diff]);

  const actions: LineAction[] = editable ? (tab.staged ? ["unstage"] : ["stage", "discard"]) : [];

  const run = async (action: LineAction, picked: LineSelection[]) => {
    if (busy || picked.length === 0) return;
    if (action === "discard") {
      const lines = picked.reduce(
        (sum, item) => sum + (item.lines?.length ?? diff.hunks[item.hunk]?.lines.length ?? 0),
        0,
      );
      const what = picked.every((item) => !item.lines) ? plural(picked.length, "hunk") : plural(lines, "line");
      const ok = await ask(`This can't be undone.`, {
        title: `Discard ${what} of ${tab.name}?`,
        confirm: "Discard",
        destructive: true,
      });
      if (!ok) return;
    }
    void workspace().applyLines(id, action, picked);
  };

  const pickedSelection = (): LineSelection[] => {
    const byHunk = new Map<number, number[]>();
    for (const item of selection) {
      const [hunk, line] = item.split(":").map(Number) as [number, number];
      byHunk.set(hunk, [...(byHunk.get(hunk) ?? []), line]);
    }
    return [...byHunk].map(([hunk, lines]) => ({ hunk, lines: lines.sort((a, b) => a - b) }));
  };

  const select = (hunk: number, line: number, event: MouseEvent) => {
    const lines = diff.hunks[hunk]!.lines;
    const changeable = (index: number) => lines[index]?.kind === "add" || lines[index]?.kind === "del";
    if (!changeable(line)) return;
    setSelection((previous) => {
      const next = new Set(previous);
      if (event.shiftKey && anchor.current?.hunk === hunk) {
        const [from, to] =
          anchor.current.line < line ? [anchor.current.line, line] : [line, anchor.current.line];
        for (let index = from; index <= to; index++) {
          if (changeable(index)) next.add(key(hunk, index));
        }
        return next;
      }
      const item = key(hunk, line);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
    if (!event.shiftKey) anchor.current = { hunk, line };
  };

  const go = (step: 1 | -1) => {
    if (starts.length === 0) return;
    const next =
      current === null ? (step === 1 ? 0 : starts.length - 1) : (current + step + starts.length) % starts.length;
    setCurrent(next);
    scroller.current
      ?.querySelector(`[data-change="${next}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const rowProps = {
    syntax,
    words,
    selection,
    startIndex,
    current,
    selectable: actions.length > 0,
    onSelect: select,
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="k-diff-bar">
        <div className="k-seg p-[2px]">
          <button
            type="button"
            title="Inline"
            aria-label="Inline"
            data-active={layout === "inline"}
            onClick={() => workspace().setDiffLayout("inline")}
            className="k-seg-btn h-[20px] px-1.5"
          >
            <Rows3 className="size-3.5" />
          </button>
          <button
            type="button"
            title="Side by side"
            aria-label="Side by side"
            data-active={layout === "split"}
            onClick={() => workspace().setDiffLayout("split")}
            className="k-seg-btn h-[20px] px-1.5"
          >
            <Columns2 className="size-3.5" />
          </button>
        </div>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="k-diff-bar-btn">
              {context >= FULL_CONTEXT ? "Whole file" : `${context} lines`}
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-auto min-w-48">
            <DropdownMenuRadioGroup
              value={String(context)}
              onValueChange={(value) => workspace().setDiffContext(Number(value))}
            >
              {CONTEXT_CHOICES.map((choice) => (
                <DropdownMenuRadioItem key={choice.value} value={String(choice.value)}>
                  {choice.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="flex-1" />
        <span className="text-small tabular-nums text-faint">
          {current === null
            ? plural(starts.length, "change")
            : `${current + 1} of ${starts.length}`}
        </span>
        <button
          type="button"
          title="Previous change (Shift+F7)"
          aria-label="Previous change"
          disabled={starts.length === 0}
          onClick={() => go(-1)}
          className="k-icon-btn size-[22px]"
        >
          <ChevronUp className="size-3.5" />
        </button>
        <button
          type="button"
          title="Next change (F7)"
          aria-label="Next change"
          disabled={starts.length === 0}
          onClick={() => go(1)}
          className="k-icon-btn size-[22px]"
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>

      <div
        ref={scroller}
        tabIndex={0}
        className="k-diff min-h-0 flex-1 overflow-auto outline-none"
        data-layout={layout}
        onKeyDown={(event) => {
          if (event.key === "F7" || (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp"))) {
            event.preventDefault();
            go(event.shiftKey || event.key === "ArrowUp" ? -1 : 1);
          } else if (event.key === "Escape" && selection.size) {
            event.preventDefault();
            setSelection(new Set());
          }
        }}
      >
        {/* Wide enough for the longest line, so tints run the full width. */}
        <div className={cn("pb-4", layout === "inline" ? "inline-block min-w-full" : "w-full")}>
          {diff.hunks.map((hunk, h) => {
            const { range, context: where } = splitHunkHeader(hunk.header);
            const hidden = hiddenBefore(diff.hunks, h);
            return (
              <section key={`${hunk.header}:${h}`}>
                {hidden > 0 ? (
                  <div className="k-diff-gap">
                    <span>⋯</span>
                    {plural(hidden, "unchanged line")}
                  </div>
                ) : null}
                <div className="k-diff-hunk">
                  <span className="shrink-0">{range}</span>
                  {where ? <span className="min-w-0 truncate text-dim">{where}</span> : null}
                  <span className="flex-1" />
                  {actions.map((action) => (
                    <HunkButton
                      key={action}
                      action={action}
                      disabled={busy}
                      onClick={() => void run(action, [{ hunk: h }])}
                    />
                  ))}
                </div>
                {layout === "inline" ? (
                  hunk.lines.map((line, l) => (
                    <InlineRow key={l} hunk={h} index={l} line={line} {...rowProps} />
                  ))
                ) : (
                  splitRows(hunk.lines).map((row, r) => (
                    <div key={r} className="k-diff-split">
                      <Half hunk={h} index={row.left} lines={hunk.lines} side="old" {...rowProps} />
                      <Half hunk={h} index={row.right} lines={hunk.lines} side="new" {...rowProps} />
                    </div>
                  ))
                )}
              </section>
            );
          })}
        </div>
      </div>

      {selection.size > 0 ? (
        <div className="k-selbar absolute bottom-3 left-1/2 w-max -translate-x-1/2" role="toolbar" aria-label="Selected lines">
          <span className="pr-1 text-body font-medium text-dim">{plural(selection.size, "line")}</span>
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              disabled={busy}
              data-danger={action === "discard" ? "true" : undefined}
              className="k-selbar-btn"
              onClick={() => void run(action, pickedSelection())}
            >
              {action === "stage" ? <Plus className="size-3.5" /> : action === "unstage" ? <Minus className="size-3.5" /> : <Undo2 className="size-3.5" />}
              {action === "stage" ? "Stage" : action === "unstage" ? "Unstage" : "Discard"}
            </button>
          ))}
          <button
            type="button"
            title="Clear selection (Esc)"
            aria-label="Clear selection"
            className="k-selbar-btn px-1.5"
            onClick={() => setSelection(new Set())}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function HunkButton({
  action,
  disabled,
  onClick,
}: {
  action: LineAction;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = action === "stage" ? "Stage hunk" : action === "unstage" ? "Unstage hunk" : "Discard hunk";
  const Icon = action === "stage" ? Plus : action === "unstage" ? Minus : Undo2;
  return (
    <button
      type="button"
      disabled={disabled}
      data-danger={action === "discard" ? "true" : undefined}
      className="k-diff-hunk-btn"
      onClick={onClick}
    >
      <Icon className="size-3" />
      {label}
    </button>
  );
}

interface RowProps {
  syntax: Map<string, StyledSpan[]> | null;
  words: Map<string, Range[]>;
  selection: Set<string>;
  startIndex: Map<string, number>;
  current: number | null;
  selectable: boolean;
  onSelect: (hunk: number, line: number, event: MouseEvent) => void;
}

function Code({ hunk, index, text, ...props }: { hunk: number; index: number; text: string } & Pick<RowProps, "syntax" | "words">) {
  const id = key(hunk, index);
  const parts = segments(text, props.syntax?.get(id) ?? [], props.words.get(id) ?? []);
  return (
    <span className="k-diff-text">
      {text
        ? parts.map((part, at) => (
            <span
              key={at}
              style={syntaxStyle(part.style)}
              className={part.changed ? "k-diff-word" : undefined}
            >
              {part.text}
            </span>
          ))
        : " "}
    </span>
  );
}

function InlineRow({
  hunk,
  index,
  line,
  ...props
}: { hunk: number; index: number; line: DiffLine } & RowProps) {
  const id = key(hunk, index);
  const change = line.kind === "add" || line.kind === "del";
  const start = props.startIndex.get(id);
  return (
    <div
      data-kind={line.kind}
      data-selected={props.selection.has(id) || undefined}
      data-change={start}
      data-current={start !== undefined && start === props.current ? "true" : undefined}
      className="k-diff-line"
    >
      <span
        className="k-diff-gutter"
        data-pick={props.selectable && change ? "true" : undefined}
        title={props.selectable && change ? "Click to pick this line, shift-click for a run" : undefined}
        onClick={(event) => props.onSelect(hunk, index, event)}
      >
        <span className="k-diff-no">{line.oldNo ?? ""}</span>
        <span className="k-diff-no">{line.newNo ?? ""}</span>
        <span className="k-diff-sign">
          {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
        </span>
      </span>
      {line.kind === "meta" ? (
        <span className="k-diff-text">{line.text}</span>
      ) : (
        <Code hunk={hunk} index={index} text={line.text} syntax={props.syntax} words={props.words} />
      )}
    </div>
  );
}

function Half({
  hunk,
  index,
  lines,
  side,
  ...props
}: {
  hunk: number;
  index: number | null;
  lines: DiffLine[];
  side: "old" | "new";
} & RowProps): ReactNode {
  if (index === null) return <div className="k-diff-half" data-kind="blank" />;
  const line = lines[index]!;
  const id = key(hunk, index);
  const change = line.kind === "add" || line.kind === "del";
  const start = props.startIndex.get(id);
  return (
    <div
      className="k-diff-half"
      data-kind={line.kind}
      data-selected={props.selection.has(id) || undefined}
      data-change={start}
      data-current={start !== undefined && start === props.current ? "true" : undefined}
    >
      <span
        className="k-diff-gutter"
        data-pick={props.selectable && change ? "true" : undefined}
        onClick={(event) => props.onSelect(hunk, index, event)}
      >
        <span className="k-diff-no">{side === "old" ? (line.oldNo ?? "") : (line.newNo ?? "")}</span>
        <span className="k-diff-sign">
          {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
        </span>
      </span>
      {line.kind === "meta" ? (
        <span className="k-diff-text">{line.text}</span>
      ) : (
        <Code hunk={hunk} index={index} text={line.text} syntax={props.syntax} words={props.words} />
      )}
    </div>
  );
}
