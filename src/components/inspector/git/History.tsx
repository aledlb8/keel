/**
 * The history, drawn as a graph.
 *
 * One row per commit: its lanes on the left, the branches and tags that sit
 * on it, the subject, and who wrote it when. Lines run unbroken from row to
 * row, and one line of descent keeps one colour all the way down. Search
 * drops the graph — a filtered history has no shape to draw.
 *
 * Click a commit to open it in place: the whole message, the files it
 * touched (each opens as a diff), and what you can do with it. Scroll to the
 * end and the next page loads.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowUp,
  Cherry,
  Copy,
  Ellipsis,
  ExternalLink,
  GitBranchPlus,
  GitCommitHorizontal,
  History as HistoryIcon,
  LogIn,
  RotateCcw,
  Search,
  Tag,
  Undo2,
} from "lucide-react";

import { Fold } from "@/components/Fold";
import { FileIcon } from "@/components/inspector/FileIcon";
import { GitLetter } from "@/components/inspector/GitLetter";
import { LoadingRows } from "@/components/inspector/LoadingRows";
import {
  ContextMenuEntries,
  DropdownMenuEntries,
  type MenuEntry,
} from "@/components/menu/MenuEntries";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fileName, parentRel, parseRef, relativeTime, remoteWebUrl } from "@/lib/git";
import { layoutGraph, type GraphEdge, type GraphRow } from "@/lib/gitGraph";
import { cn } from "@/lib/utils";
import type { CommitDetails, GitCommit, GitStatus } from "@/lib/workspace";
import { useWorkspace } from "@/state/workspace";

import {
  Avatar,
  copy,
  Empty,
  FilterField,
  MetaContent,
  plural,
  RefChip,
  refName,
  Stat,
  usePrompt,
  type PromptSpec,
} from "./shared";

const workspace = useWorkspace.getState;

const ROW = 44;
const LANE = 12;
const PAD = 10;
/** Past this many lanes the graph stops widening and the outer ones clip. */
const MAX_LANES = 7;

const LANE_COLORS = [
  "var(--keel-ansi-blue)",
  "var(--keel-ansi-magenta)",
  "var(--keel-ansi-cyan)",
  "var(--keel-done)",
  "var(--keel-working)",
  "var(--keel-ansi-red)",
  "var(--keel-ansi-bright-blue)",
  "var(--keel-ansi-bright-magenta)",
];

const laneColor = (color: number) => LANE_COLORS[color % LANE_COLORS.length];
const laneX = (lane: number) => PAD + lane * LANE;

export function HistoryView({ git }: { git: GitStatus }) {
  const commits = useWorkspace((state) => state.commits);
  const all = useWorkspace((state) => state.historyAll);
  const query = useWorkspace((state) => state.historyQuery);
  const more = useWorkspace((state) => state.historyMore);
  const paging = useWorkspace((state) => state.historyPaging);
  const remotes = useWorkspace((state) => state.remotes);
  const [draft, setDraft] = useState(query);
  const [open, setOpen] = useState<string | null>(null);
  const end = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void workspace().refreshHistory();
    if (!workspace().remotes) void workspace().refreshRemotes();
  }, [git.head, git.branch]);

  // Search as you type, once the typing settles.
  useEffect(() => {
    const timer = window.setTimeout(() => workspace().setHistoryQuery(draft.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [draft]);

  // The last row coming into view asks for the next page.
  useEffect(() => {
    const target = end.current;
    if (!target) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void workspace().loadMoreHistory();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [commits]);

  const graph = useMemo(
    () => (commits && !query ? layoutGraph(commits) : null),
    [commits, query],
  );
  const lanes = Math.min(
    MAX_LANES,
    Math.max(1, ...(graph ?? []).map((row) => row.width)),
  );
  const remoteNames = remotes?.map((remote) => remote.name) ?? ["origin"];
  const web = useMemo(() => {
    const origin = remotes?.find((remote) => remote.name === "origin") ?? remotes?.[0];
    return origin ? remoteWebUrl(origin.url) : null;
  }, [remotes]);

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 px-[var(--keel-inset)] pb-1.5">
        <FilterField
          value={draft}
          onChange={setDraft}
          placeholder="Search commit messages"
          icon={Search}
        />
        <div className="k-seg shrink-0 p-[2px]">
          <button
            type="button"
            title="Only the current branch"
            data-active={!all}
            onClick={() => workspace().setHistoryAll(false)}
            className="k-seg-btn h-[20px] px-2 text-small"
          >
            Current
          </button>
          <button
            type="button"
            title="Every branch, remote and tag"
            data-active={all}
            onClick={() => workspace().setHistoryAll(true)}
            className="k-seg-btn h-[20px] px-2 text-small"
          >
            All
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 [mask-image:linear-gradient(to_bottom,transparent,black_8px)]">
        <div className="pt-1" />
        <MetaContent section="history" loaded={commits !== null} rows={10}>
          {commits && commits.length === 0 ? (
            query ? (
              <Empty icon={Search} title="No commits match" detail={`Nothing in the messages mentions “${query}”.`} />
            ) : (
              <Empty icon={HistoryIcon} title="No commits yet" detail="Your first commit will start the history." />
            )
          ) : null}
          {commits?.map((commit, index) => (
            <CommitItem
              key={commit.hash}
              commit={commit}
              row={graph?.[index] ?? null}
              lanes={lanes}
              remotes={remoteNames}
              web={web}
              open={open === commit.hash}
              onToggle={() => setOpen((current) => (current === commit.hash ? null : commit.hash))}
            />
          ))}
          <div ref={end} className="h-px" />
          {paging ? <LoadingRows label="Loading more commits" rows={3} /> : null}
          {commits && commits.length > 0 && !more ? (
            <p className="px-[calc(var(--keel-inset)+8px)] pt-2 text-center text-small text-faint">
              {plural(commits.length, "commit")}
            </p>
          ) : null}
        </MetaContent>
      </div>
    </>
  );
}

// ---- One commit ---------------------------------------------------------------

function CommitItem({
  commit,
  row,
  lanes,
  remotes,
  web,
  open,
  onToggle,
}: {
  commit: GitCommit;
  row: GraphRow | null;
  lanes: number;
  remotes: string[];
  web: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const prompt = usePrompt();
  const refs = commit.refs.map((ref) => parseRef(ref, remotes));
  const isHead = refs.some((ref) => ref.current);
  const shown = refs.slice(0, 2);
  const hidden = refs.length - shown.length;

  useEffect(() => {
    if (open) void workspace().loadCommitDetails(commit.hash);
  }, [open, commit.hash]);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            aria-expanded={open}
            data-open={open}
            className="k-commit"
            title={`${commit.subject}\n${commit.short} · ${commit.author}`}
            onClick={onToggle}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onToggle();
              }
            }}
          >
            {row ? (
              <GraphCell row={row} lanes={lanes} head={isHead} merge={commit.parents.length > 1} />
            ) : (
              <span className="w-2.5 shrink-0" />
            )}
            <span className="flex min-w-0 flex-1 flex-col justify-center gap-[3px]">
              <span className="flex min-w-0 items-center gap-1.5">
                {shown.map((ref) => (
                  <RefChip key={`${ref.kind}:${ref.name}`} label={ref} />
                ))}
                {hidden > 0 ? (
                  <span className="k-tag h-4 shrink-0 px-1 text-micro" title={commit.refs.slice(2).join("\n")}>
                    +{hidden}
                  </span>
                ) : null}
                <span className="k-commit-subject min-w-0 text-body">{commit.subject}</span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-small text-faint">
                <Avatar name={commit.author} />
                <span className="min-w-0 truncate">{commit.author}</span>
                <span className="shrink-0">· {relativeTime(commit.timestamp)}</span>
                {commit.unpushed ? (
                  <span title="Not pushed yet" className="shrink-0">
                    <ArrowUp aria-label="Not pushed yet" className="size-3 text-[color:var(--keel-working)]" />
                  </span>
                ) : null}
                <span className="flex-1" />
                <span className="shrink-0 font-mono text-micro">{commit.short}</span>
              </span>
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuEntries entries={() => commitMenu(commit, isHead, web, prompt)} />
        </ContextMenuContent>
      </ContextMenu>
      <Fold open={open}>
        <div className="mx-[var(--keel-inset)] flex">
          {row ? <GapCell edges={row.after} lanes={lanes} /> : <span className="w-2.5 shrink-0" />}
          <div className="min-w-0 flex-1 pr-1">
            <CommitCard commit={commit} isHead={isHead} web={web} />
          </div>
        </div>
      </Fold>
    </>
  );
}

function graphWidth(lanes: number) {
  return PAD * 2 + (lanes - 1) * LANE;
}

function GraphCell({
  row,
  lanes,
  head,
  merge,
}: {
  row: GraphRow;
  lanes: number;
  head: boolean;
  merge: boolean;
}) {
  const mid = ROW / 2;
  const x = laneX(row.lane);
  const color = laneColor(row.color);
  return (
    <svg
      aria-hidden
      width={graphWidth(lanes)}
      height={ROW}
      className="shrink-0 overflow-hidden"
      fill="none"
      strokeWidth={1.6}
      strokeLinecap="round"
    >
      {row.through.map((edge) => (
        <line
          key={`t${edge.lane}`}
          x1={laneX(edge.lane)}
          y1={0}
          x2={laneX(edge.lane)}
          y2={ROW}
          stroke={laneColor(edge.color)}
        />
      ))}
      {row.incoming.map((edge) => {
        const from = laneX(edge.lane);
        return (
          <path
            key={`i${edge.lane}`}
            stroke={laneColor(edge.color)}
            d={
              edge.lane === row.lane
                ? `M ${from} 0 L ${x} ${mid}`
                : `M ${from} 0 C ${from} ${mid * 0.8}, ${x} ${mid * 0.45}, ${x} ${mid}`
            }
          />
        );
      })}
      {row.outgoing.map((edge) => {
        const to = laneX(edge.lane);
        return (
          <path
            key={`o${edge.lane}`}
            stroke={laneColor(edge.color)}
            d={
              edge.lane === row.lane
                ? `M ${x} ${mid} L ${to} ${ROW}`
                : `M ${x} ${mid} C ${x} ${mid + mid * 0.55}, ${to} ${mid + mid * 0.2}, ${to} ${ROW}`
            }
          />
        );
      })}
      {head ? <circle cx={x} cy={mid} r={7} stroke={color} strokeOpacity={0.35} strokeWidth={2} /> : null}
      {merge ? (
        <circle cx={x} cy={mid} r={3.6} fill="var(--keel-chrome)" stroke={color} strokeWidth={2} />
      ) : (
        <circle cx={x} cy={mid} r={4.2} fill={color} stroke="var(--keel-chrome)" strokeWidth={1.5} />
      )}
    </svg>
  );
}

/** The lanes carrying on past an opened commit, drawn down beside its card. */
function GapCell({ edges, lanes }: { edges: GraphEdge[]; lanes: number }) {
  return (
    <svg
      aria-hidden
      width={graphWidth(lanes)}
      height="100%"
      viewBox={`0 0 ${graphWidth(lanes)} 100`}
      preserveAspectRatio="none"
      className="shrink-0 self-stretch"
      strokeWidth={1.6}
    >
      {edges.map((edge) => (
        <line
          key={edge.lane}
          x1={laneX(edge.lane)}
          y1={0}
          x2={laneX(edge.lane)}
          y2={100}
          stroke={laneColor(edge.color)}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

function CommitCard({
  commit,
  isHead,
  web,
}: {
  commit: GitCommit;
  isHead: boolean;
  web: string | null;
}) {
  const details = useWorkspace((state) => state.commitDetails[commit.hash]);
  const prompt = usePrompt();
  return (
    <div className="k-commit-card">
      <div className="px-3 pb-2 pt-2.5">
        <p className="select-text text-body font-medium leading-snug text-foreground">{commit.subject}</p>
        {details?.body ? (
          <p className="mt-1.5 max-h-40 select-text overflow-y-auto whitespace-pre-wrap text-body leading-relaxed text-dim">
            {details.body}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-faint">
          <span className="flex min-w-0 items-center gap-1.5" title={commit.email}>
            <Avatar name={commit.author} />
            <span className="truncate text-dim">{commit.author}</span>
          </span>
          <span title={new Date(commit.timestamp * 1000).toLocaleString()}>
            {new Date(commit.timestamp * 1000).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
          {details && details.committer !== commit.author ? (
            <span>committed by {details.committer}</span>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <button
            type="button"
            className="k-tag gap-1 font-mono"
            title="Copy the full hash"
            onClick={() => copy(commit.hash, `Copied ${commit.short}`)}
          >
            <Copy className="size-2.5" />
            {commit.short}
          </button>
          {commit.parents.length > 1 ? (
            <span className="k-tag">merge of {commit.parents.map((p) => p.slice(0, 7)).join(" + ")}</span>
          ) : null}
          <CardAction icon={LogIn} label="Check out" onClick={() => checkoutCommit(commit)} />
          <CardAction icon={GitBranchPlus} label="Branch" onClick={() => prompt(branchPrompt(commit))} />
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="More for this commit" className="k-icon-btn size-[22px]">
                <Ellipsis className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-56">
              <DropdownMenuEntries entries={() => commitMenu(commit, isHead, web, prompt)} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="border-t border-line pb-1 pt-1">
        {!details ? (
          <LoadingRows label="Loading the commit" rows={3} />
        ) : details.files.length === 0 ? (
          <p className="px-3 py-1.5 text-small text-faint">No file changes.</p>
        ) : (
          <>
            <FilesHeader details={details} />
            {details.files.map((file) => (
              <div
                key={file.path}
                role="button"
                tabIndex={0}
                title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                className="k-row k-row-dense mx-1 w-[calc(100%-8px)] gap-2"
                onClick={() => void workspace().openCommitDiff(commit.hash, file)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void workspace().openCommitDiff(commit.hash, file);
                  }
                }}
              >
                <FileIcon name={fileName(file.path)} />
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span
                    className={cn(
                      "max-w-full shrink-0 truncate text-body text-dim",
                      file.status === "deleted" && "line-through decoration-foreground/25",
                    )}
                  >
                    {fileName(file.path)}
                  </span>
                  <span className="min-w-0 truncate text-small text-faint">{parentRel(file.path)}</span>
                </span>
                <Stat stat={file.stat} />
                <GitLetter status={file.status} />
              </div>
            ))}
            {details.truncated ? (
              <p className="px-3 py-1 text-small text-faint">More files changed than are listed.</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function FilesHeader({ details }: { details: CommitDetails }) {
  let added = 0;
  let removed = 0;
  for (const file of details.files) {
    added += file.stat?.added ?? 0;
    removed += file.stat?.removed ?? 0;
  }
  return (
    <p className="flex items-center gap-2 px-3 pb-0.5 pt-1 text-small text-faint">
      <span className="flex-1">{plural(details.files.length, "file")} changed</span>
      <Stat stat={{ added, removed, binary: false }} />
    </p>
  );
}

function CardAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Tag;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="k-tag gap-1 hover:bg-veil-3 hover:text-foreground"
    >
      <Icon className="size-3" />
      {label}
    </button>
  );
}

// ---- What a commit offers -----------------------------------------------------

function checkoutCommit(commit: GitCommit) {
  const ok = window.confirm(
    `Check out ${commit.short}? You'll be on a detached HEAD: commits made there belong to no branch until you create one.`,
  );
  if (ok) void workspace().checkoutRev(commit.hash);
}

function branchPrompt(commit: GitCommit): PromptSpec {
  return {
    title: "New branch",
    detail: `Starts from ${commit.short}, “${commit.subject}”.`,
    confirm: "Create and switch",
    fields: [{ key: "name", label: "Name", placeholder: "feature/something", transform: refName }],
    onSubmit: ({ name }) => void workspace().createBranch(name ?? "", true, commit.hash),
  };
}

function tagPrompt(commit: GitCommit): PromptSpec {
  return {
    title: "New tag",
    detail: `On ${commit.short}. A message makes it an annotated tag.`,
    confirm: "Create tag",
    fields: [
      { key: "name", label: "Name", placeholder: "v1.0.0", transform: refName },
      { key: "message", label: "Message", optional: true, multiline: true, placeholder: "Release notes" },
    ],
    onSubmit: ({ name, message }) =>
      void workspace().createTag(name ?? "", commit.hash, message || null),
  };
}

function commitMenu(
  commit: GitCommit,
  isHead: boolean,
  web: string | null,
  prompt: (spec: PromptSpec) => void,
): MenuEntry[] {
  const state = workspace();
  const branch = state.git?.branch ?? "this branch";
  return [
    { kind: "item", label: "Copy hash", icon: Copy, onSelect: () => copy(commit.hash, `Copied ${commit.short}`) },
    { kind: "item", label: "Copy message", onSelect: () => copy(commit.subject, "Copied the message") },
    ...(web
      ? [{
          kind: "item" as const,
          label: "Open on the web",
          icon: ExternalLink,
          onSelect: () => void openUrl(`${web}/commit/${commit.hash}`).catch(() => {}),
        }]
      : []),
    { kind: "separator" },
    { kind: "item", label: "Check out this commit", icon: LogIn, onSelect: () => checkoutCommit(commit) },
    { kind: "item", label: "New branch from here…", icon: GitBranchPlus, onSelect: () => prompt(branchPrompt(commit)) },
    { kind: "item", label: "New tag here…", icon: Tag, onSelect: () => prompt(tagPrompt(commit)) },
    { kind: "separator" },
    {
      kind: "item",
      label: `Cherry-pick onto ${branch}`,
      icon: Cherry,
      disabled: isHead,
      onSelect: () => void state.cherryPick(commit.hash),
    },
    {
      kind: "item",
      label: "Revert this commit",
      icon: RotateCcw,
      onSelect: () => void state.revert(commit.hash),
    },
    ...(isHead && commit.unpushed
      ? [{ kind: "item" as const, label: "Undo this commit", icon: Undo2, onSelect: () => void state.undoCommit() }]
      : []),
    {
      kind: "sub",
      label: `Reset ${branch} to here`,
      icon: GitCommitHorizontal,
      disabled: isHead,
      entries: [
        { kind: "item", label: "Soft — keep changes staged", onSelect: () => void state.reset(commit.hash, "soft") },
        { kind: "item", label: "Mixed — keep changes unstaged", onSelect: () => void state.reset(commit.hash, "mixed") },
        {
          kind: "item",
          label: "Hard — throw changes away",
          destructive: true,
          confirm: "Discard every later commit and change?",
          onSelect: () => void state.reset(commit.hash, "hard"),
        },
      ],
    },
  ];
}
