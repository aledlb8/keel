/**
 * Where you are and how far it is from the remote: the branch picker, the
 * sync buttons, and the menu with everything else you might do to the
 * repository as a whole. Under it, when a merge or a rebase has stopped
 * halfway, the banner that lets you finish or abandon it.
 */

import { useMemo, useRef, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Cloud,
  Copy,
  Ellipsis,
  ExternalLink,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  RefreshCw,
  Search,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { LoadingRows } from "@/components/inspector/LoadingRows";
import { DropdownMenuEntries, type MenuEntry } from "@/components/menu/MenuEntries";
import { MENU_SURFACE } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { relativeTime, remoteWebUrl } from "@/lib/git";
import { cn } from "@/lib/utils";
import type { GitBranch as Branch, GitStatus } from "@/lib/workspace";
import { useWorkspace } from "@/state/workspace";

import { copy, plural, refName, usePrompt } from "./shared";

const workspace = useWorkspace.getState;

export function RepoBar({ git, busy }: { git: GitStatus; busy: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-[var(--keel-inset)] pb-2">
      <BranchPicker git={git} busy={busy} />
      <SyncButtons git={git} busy={busy} />
      <RepoMenu git={git} busy={busy} />
    </div>
  );
}

// ---- Branch picker ----------------------------------------------------------

type PickItem =
  | { kind: "create"; name: string }
  | { kind: "branch"; branch: Branch };

function BranchPicker({ git, busy }: { git: GitStatus; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const branches = useWorkspace((state) => state.branches);
  const error = useWorkspace((state) => state.metaErrors.branches);
  const prompt = usePrompt();
  const list = useRef<HTMLDivElement | null>(null);

  const label = git.detached ? `HEAD at ${git.head ?? "…"}` : (git.branch ?? "No branch");
  const needle = query.trim().toLowerCase();

  const { local, remote, items } = useMemo(() => {
    const all = branches?.items ?? [];
    const match = (branch: Branch) => !needle || branch.name.toLowerCase().includes(needle);
    const local = all.filter((branch) => !branch.remote && match(branch));
    const localNames = new Set(all.filter((b) => !b.remote).map((b) => b.name));
    // A remote branch with a local twin is reached through the twin.
    const remote = all.filter(
      (branch) =>
        branch.remote &&
        match(branch) &&
        !localNames.has(branch.name.slice(branch.name.indexOf("/") + 1)),
    );
    const exact = all.some((branch) => branch.name.toLowerCase() === needle);
    const name = refName(query.trim());
    const items: PickItem[] = [
      ...(name && !exact ? [{ kind: "create" as const, name }] : []),
      ...local.map((branch) => ({ kind: "branch" as const, branch })),
      ...remote.map((branch) => ({ kind: "branch" as const, branch })),
    ];
    return { local, remote, items };
  }, [branches, needle, query]);

  const choose = (item: PickItem | undefined) => {
    if (!item || busy) return;
    setOpen(false);
    if (item.kind === "create") {
      void workspace().createBranch(item.name, true);
    } else if (item.branch.remote) {
      void workspace().checkoutRemote(item.branch.name);
    } else if (!item.branch.current) {
      void workspace().checkout(item.branch.name);
    }
  };

  const move = (step: number) => {
    if (items.length === 0) return;
    const next = (active + step + items.length) % items.length;
    setActive(next);
    list.current
      ?.querySelector(`[data-index="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  let index = items[0]?.kind === "create" ? 1 : 0;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setActive(0);
          void workspace().refreshBranches();
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          title={git.upstream ? `${label} → ${git.upstream}` : label}
          className="k-field k-field-button min-w-0 flex-1"
        >
          <GitBranch aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left text-body font-medium text-foreground">
            {label}
          </span>
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() =>
              list.current?.parentElement?.querySelector("input")?.focus(),
            );
          }}
          className={cn(
            MENU_SURFACE,
            "flex max-h-[min(460px,var(--radix-popover-content-available-height))] w-[max(300px,var(--radix-popover-trigger-width))] flex-col p-1.5",
          )}
        >
          <div className="k-field k-field-sm mb-1.5 shrink-0">
            <Search aria-hidden className="size-3.5 shrink-0" />
            <input
              value={query}
              spellCheck={false}
              placeholder="Switch to or create a branch"
              aria-label="Find a branch"
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  move(1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  move(-1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  choose(items[active]);
                }
              }}
            />
          </div>
          <div ref={list} role="listbox" aria-label="Branches" className="min-h-0 overflow-y-auto">
            {items[0]?.kind === "create" ? (
              <PickRow
                index={0}
                active={active === 0}
                onHover={() => setActive(0)}
                onPick={() => choose(items[0])}
              >
                <GitBranchPlus aria-hidden className="size-3.5 shrink-0 text-dim" />
                <span className="min-w-0 flex-1 truncate">
                  Create <span className="font-medium text-foreground">{items[0].name}</span>
                </span>
                <span className="shrink-0 text-small text-faint">from {label}</span>
              </PickRow>
            ) : null}
            {!branches ? (
              error ? (
                <p className="px-2.5 py-2 text-body text-faint">Couldn't load branches.</p>
              ) : (
                <LoadingRows label="Loading branches" rows={4} />
              )
            ) : (
              <>
                {local.length > 0 ? <PickLabel>Local</PickLabel> : null}
                {local.map((branch) => {
                  const at = index++;
                  return (
                    <PickRow
                      key={branch.name}
                      index={at}
                      active={active === at}
                      onHover={() => setActive(at)}
                      onPick={() => choose(items[at])}
                    >
                      {branch.current ? (
                        <Check aria-hidden className="size-3.5 shrink-0 text-foreground" />
                      ) : (
                        <GitBranch aria-hidden className="size-3.5 shrink-0 text-faint" />
                      )}
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          branch.current && "font-medium",
                        )}
                      >
                        {branch.name}
                      </span>
                      <BranchSync branch={branch} />
                      {branch.timestamp ? (
                        <span className="shrink-0 text-small text-faint">
                          {relativeTime(branch.timestamp)}
                        </span>
                      ) : null}
                    </PickRow>
                  );
                })}
                {remote.length > 0 ? <PickLabel>Remote</PickLabel> : null}
                {remote.map((branch) => {
                  const at = index++;
                  return (
                    <PickRow
                      key={branch.name}
                      index={at}
                      active={active === at}
                      onHover={() => setActive(at)}
                      onPick={() => choose(items[at])}
                    >
                      <Cloud aria-hidden className="size-3.5 shrink-0 text-faint" />
                      <span className="min-w-0 flex-1 truncate text-dim">{branch.name}</span>
                      {branch.timestamp ? (
                        <span className="shrink-0 text-small text-faint">
                          {relativeTime(branch.timestamp)}
                        </span>
                      ) : null}
                    </PickRow>
                  );
                })}
                {items.length === 0 ? (
                  <p className="px-2.5 py-2 text-body text-faint">No branches match.</p>
                ) : null}
              </>
            )}
          </div>
          <div className="mt-1.5 flex shrink-0 gap-1 border-t border-line pt-1.5">
            <button
              type="button"
              className="flex h-7 flex-1 items-center gap-2 rounded-[var(--keel-r-chip)] px-2 text-body text-dim hover:bg-veil-2 hover:text-foreground"
              onClick={() => {
                setOpen(false);
                prompt({
                  title: "New branch",
                  detail: `Starts from ${label}.`,
                  confirm: "Create and switch",
                  fields: [
                    {
                      key: "name",
                      label: "Name",
                      placeholder: "feature/something",
                      initial: refName(query.trim()),
                      transform: refName,
                    },
                  ],
                  onSubmit: ({ name }) => void workspace().createBranch(name ?? "", true),
                });
              }}
            >
              <GitBranchPlus aria-hidden className="size-3.5" />
              New branch…
            </button>
            <button
              type="button"
              className="flex h-7 items-center gap-2 rounded-[var(--keel-r-chip)] px-2 text-body text-dim hover:bg-veil-2 hover:text-foreground"
              onClick={() => {
                setOpen(false);
                workspace().setGitView("branches");
              }}
            >
              Manage
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PickLabel({ children }: { children: string }) {
  return <p className="px-2.5 pb-1 pt-2 text-small font-medium text-faint">{children}</p>;
}

function PickRow({
  index,
  active,
  onHover,
  onPick,
  children,
}: {
  index: number;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      data-index={index}
      onMouseMove={onHover}
      onClick={onPick}
      className={cn(
        "flex h-[var(--keel-h-dense)] cursor-default items-center gap-2.5 rounded-[var(--keel-r-chip)] px-2.5 text-row text-foreground",
        active && "bg-veil-3",
      )}
    >
      {children}
    </div>
  );
}

/** "↑2 ↓1" against a branch's upstream, or "gone" when that was deleted. */
export function BranchSync({ branch }: { branch: Branch }) {
  if (branch.gone) {
    return (
      <span className="k-tag shrink-0 text-[color:var(--keel-dead)]" title="Its upstream was deleted">
        gone
      </span>
    );
  }
  if (!branch.ahead && !branch.behind) return null;
  return (
    <span
      className="k-stat shrink-0 text-faint"
      title={[
        branch.ahead ? `${plural(branch.ahead, "commit")} to push` : "",
        branch.behind ? `${plural(branch.behind, "commit")} to pull` : "",
      ]
        .filter(Boolean)
        .join(", ")}
    >
      {branch.ahead ? <span>↑{branch.ahead}</span> : null}
      {branch.behind ? <span>↓{branch.behind}</span> : null}
    </span>
  );
}

// ---- Sync -------------------------------------------------------------------

function SyncButtons({ git, busy }: { git: GitStatus; busy: boolean }) {
  const published = Boolean(git.upstream);
  const remote = git.hasRemote !== false;
  const fetched = git.lastFetch ? `Last fetched ${relativeTime(git.lastFetch)}` : "Never fetched";
  return (
    <div className="k-seg shrink-0">
      <SyncButton
        label={git.behind ? `Pull ${plural(git.behind, "commit")}` : "Pull"}
        count={git.behind}
        disabled={busy || !published}
        onClick={() => void workspace().pull()}
      >
        <ArrowDown className="size-3.5" />
      </SyncButton>
      <SyncButton
        label={
          !remote
            ? "No remote to push to"
            : !published
              ? "Publish this branch"
              : git.ahead
                ? `Push ${plural(git.ahead, "commit")}`
                : "Push"
        }
        count={git.ahead}
        lit={remote && !published && !git.detached && Boolean(git.head)}
        disabled={busy || git.detached || !remote}
        onClick={() => void workspace().push()}
      >
        {published ? <ArrowUp className="size-3.5" /> : <Cloud className="size-3.5" />}
      </SyncButton>
      <SyncButton
        label={remote ? `Fetch · ${fetched}` : "No remote to fetch from"}
        disabled={busy || !remote}
        onClick={() => void workspace().fetch()}
      >
        <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
      </SyncButton>
    </div>
  );
}

function SyncButton({
  label,
  count = 0,
  lit = false,
  disabled,
  onClick,
  children,
}: {
  label: string;
  count?: number;
  lit?: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // Lit when there is something to move, so the direction reads at a glance.
      data-active={count > 0 || lit}
      disabled={disabled}
      onClick={onClick}
      className="k-seg-btn gap-1 px-[7px] disabled:opacity-40"
    >
      {children}
      {count ? <span className="text-small tabular-nums">{count}</span> : null}
    </button>
  );
}

// ---- Everything else --------------------------------------------------------

function RepoMenu({ git, busy }: { git: GitStatus; busy: boolean }) {
  const remotes = useWorkspace((state) => state.remotes);
  const prompt = usePrompt();
  const changes = git.files.length;
  // Undoing a commit is only safe while nobody else can have it.
  const undoable = Boolean(git.head) && !git.detached && (!git.upstream || git.ahead > 0);

  const entries = (): MenuEntry[] => {
    const origin = remotes?.find((remote) => remote.name === "origin") ?? remotes?.[0];
    const web = origin ? remoteWebUrl(origin.url) : null;
    return [
      {
        kind: "sub",
        label: "Pull",
        icon: ArrowDown,
        disabled: busy || !git.upstream,
        entries: [
          { kind: "item", label: "Fast-forward only", onSelect: () => void workspace().pull("ff-only") },
          { kind: "item", label: "Rebase onto upstream", onSelect: () => void workspace().pull("rebase") },
          { kind: "item", label: "Merge upstream", onSelect: () => void workspace().pull("merge") },
        ],
      },
      {
        kind: "sub",
        label: "Push",
        icon: ArrowUp,
        disabled: busy || git.detached || git.hasRemote === false,
        entries: [
          {
            kind: "item",
            label: git.upstream ? "Push" : "Publish branch",
            onSelect: () => void workspace().push(),
          },
          {
            kind: "item",
            label: "Force push (with lease)",
            destructive: true,
            confirm: "Overwrite the remote branch?",
            onSelect: () => void workspace().push(true),
          },
        ],
      },
      {
        kind: "item",
        label: "Fetch all remotes",
        icon: RefreshCw,
        disabled: busy || git.hasRemote === false,
        onSelect: () => void workspace().fetch(),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Stash all changes…",
        icon: Archive,
        disabled: busy || changes === 0,
        onSelect: () =>
          prompt({
            title: "Stash changes",
            detail: `Sets aside ${plural(changes, "change")}, untracked files included, and leaves a clean tree.`,
            confirm: "Stash",
            fields: [{ key: "message", label: "Message", placeholder: "What you were in the middle of", optional: true }],
            onSubmit: ({ message }) =>
              void workspace().stashPush({ message: message ?? null, includeUntracked: true }),
          }),
      },
      {
        kind: "item",
        label: "Undo last commit",
        icon: Undo2,
        disabled: busy || !undoable,
        onSelect: () => void workspace().undoCommit(),
      },
      { kind: "separator" },
      ...(web
        ? [
            {
              kind: "item" as const,
              label: `Open on ${new URL(web).hostname.replace(/^www\./, "")}`,
              icon: ExternalLink,
              onSelect: () => {
                const branch = git.branch && git.upstream ? `/tree/${git.branch}` : "";
                void openUrl(`${web}${branch}`).catch(() => {});
              },
            },
          ]
        : []),
      {
        kind: "item",
        label: "Copy branch name",
        icon: Copy,
        disabled: !git.branch,
        onSelect: () => copy(git.branch ?? "", `Copied ${git.branch}`),
      },
      {
        kind: "item",
        label: "Refresh",
        icon: RefreshCw,
        onSelect: () => {
          void workspace().refreshGit();
          void workspace().refreshMeta();
        },
      },
    ];
  };

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open && !remotes) void workspace().refreshRemotes();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="More git actions"
          title="More git actions"
          className="k-icon-btn size-[30px] shrink-0"
        >
          <Ellipsis className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-56">
        <DropdownMenuEntries entries={entries} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---- Halfway ----------------------------------------------------------------

const OPERATION_NAMES = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
} as const;

export function OperationBanner({ git, busy }: { git: GitStatus; busy: boolean }) {
  if (!git.operation) return null;
  const conflicts = git.files.filter((file) => file.conflict).length;
  const name = OPERATION_NAMES[git.operation];
  const canSkip = git.operation !== "merge";
  return (
    <div
      role="status"
      className="k-banner mb-2 flex flex-col gap-2"
      style={{ ["--tone" as string]: conflicts ? "var(--keel-dead)" : "var(--keel-working)" }}
    >
      <div className="flex items-start gap-2.5">
        {conflicts ? (
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-[color:var(--keel-dead)]" />
        ) : (
          <GitMerge aria-hidden className="mt-px size-3.5 shrink-0 text-[color:var(--keel-working)]" />
        )}
        <div className="min-w-0">
          <p className="text-body font-medium text-foreground">{name} in progress</p>
          <p className="text-small leading-snug text-dim">
            {conflicts
              ? `${plural(conflicts, "conflict")} to resolve. Stage a file once it's fixed.`
              : "Conflicts resolved. Continue to finish."}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1">
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Abort the ${name.toLowerCase()}? Its changes so far will be thrown away.`)) {
              void workspace().operation("abort");
            }
          }}
        >
          Abort
        </Button>
        {canSkip ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void workspace().operation("skip")}>
            Skip
          </Button>
        ) : null}
        <Button
          size="xs"
          disabled={busy || conflicts > 0}
          onClick={() => void workspace().operation("continue")}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
