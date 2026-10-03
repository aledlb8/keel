/**
 * Every branch and tag, and everything you can do with one.
 *
 * Local branches first, most recently touched at the top, each with how far
 * it has drifted from its upstream. Remote branches and tags fold below.
 * Click a branch to switch to it; right-click, or the button that appears on
 * hover, for merging, rebasing, renaming, pushing and deleting.
 */

import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowUp,
  Check,
  Cloud,
  Copy,
  Ellipsis,
  ExternalLink,
  Filter,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  GitPullRequestArrow,
  LogIn,
  Pencil,
  Tag,
  Trash2,
  Upload,
} from "lucide-react";

import { BranchSync } from "./RepoBar";
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
import { relativeTime, remoteWebUrl } from "@/lib/git";
import { ask } from "@/lib/ask";
import { cn } from "@/lib/utils";
import type { GitBranch as Branch, GitStatus, GitTag } from "@/lib/workspace";
import { useWorkspace } from "@/state/workspace";

import {
  copy,
  Empty,
  FilterField,
  isControl,
  MetaContent,
  refName,
  Section,
  usePrompt,
  type PromptSpec,
} from "./shared";

const workspace = useWorkspace.getState;

export function BranchesView({ git, busy }: { git: GitStatus; busy: boolean }) {
  const branches = useWorkspace((state) => state.branches);
  const tags = useWorkspace((state) => state.tags);
  const remotes = useWorkspace((state) => state.remotes);
  const prompt = usePrompt();
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState({ local: true, remote: false, tags: false });

  useEffect(() => {
    void workspace().refreshBranches();
    void workspace().refreshTags();
    if (!workspace().remotes) void workspace().refreshRemotes();
  }, [git.head, git.branch]);

  const needle = filter.trim().toLowerCase();
  const match = (name: string) => !needle || name.toLowerCase().includes(needle);
  const local = (branches?.items ?? []).filter((branch) => !branch.remote && match(branch.name));
  const remote = (branches?.items ?? []).filter((branch) => branch.remote && match(branch.name));
  const shownTags = (tags ?? []).filter((tag) => match(tag.name));
  // While filtering, open whatever has a match.
  const isOpen = (key: keyof typeof open, count: number) => (needle ? count > 0 : open[key]);
  const web = useMemo(() => {
    const origin = remotes?.find((item) => item.name === "origin") ?? remotes?.[0];
    return origin ? remoteWebUrl(origin.url) : null;
  }, [remotes]);
  const current = git.branch;

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 px-[var(--keel-inset)] pb-1.5">
        <FilterField value={filter} onChange={setFilter} placeholder="Filter branches and tags" icon={Filter} />
        <button
          type="button"
          title="New branch"
          aria-label="New branch"
          disabled={busy}
          onClick={() => prompt(newBranchPrompt(git.detached ? `HEAD (${git.head ?? ""})` : (current ?? "HEAD"), null, filter))}
          className="k-icon-btn size-[26px] disabled:opacity-40"
          data-primary="true"
        >
          <GitBranchPlus className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 [mask-image:linear-gradient(to_bottom,transparent,black_8px)]">
        <div className="pt-1" />
        <MetaContent section="branches" loaded={branches !== null} rows={6}>
          <Section
            title="Local"
            count={local.length}
            open={isOpen("local", local.length)}
            onToggle={() => setOpen((previous) => ({ ...previous, local: !previous.local }))}
          >
            {local.length === 0 ? (
              <p className="px-[calc(var(--keel-inset)+8px)] py-1 text-body text-faint">
                {needle ? "No local branches match." : "No branches yet."}
              </p>
            ) : (
              local.map((branch) => (
                <BranchRow key={branch.name} branch={branch} current={current} busy={busy} web={web} />
              ))
            )}
          </Section>
          {remote.length > 0 || !needle ? (
            <Section
              title="Remote"
              count={remote.length}
              open={isOpen("remote", remote.length)}
              onToggle={() => setOpen((previous) => ({ ...previous, remote: !previous.remote }))}
            >
              {remote.length === 0 ? (
                <p className="px-[calc(var(--keel-inset)+8px)] py-1 text-body text-faint">
                  No remote branches. Fetch to see what's there.
                </p>
              ) : (
                remote.map((branch) => (
                  <BranchRow key={branch.name} branch={branch} current={current} busy={busy} web={web} />
                ))
              )}
            </Section>
          ) : null}
          {shownTags.length > 0 || !needle ? (
            <Section
              title="Tags"
              count={shownTags.length}
              open={isOpen("tags", shownTags.length)}
              onToggle={() => setOpen((previous) => ({ ...previous, tags: !previous.tags }))}
            >
              {tags === null ? null : shownTags.length === 0 ? (
                <p className="px-[calc(var(--keel-inset)+8px)] py-1 text-body text-faint">
                  No tags. Tag a commit from the history.
                </p>
              ) : (
                shownTags.map((tag) => <TagRow key={tag.name} tag={tag} busy={busy} />)
              )}
            </Section>
          ) : null}
          {needle && local.length + remote.length + shownTags.length === 0 ? (
            <Empty icon={GitBranch} title="Nothing matches" detail={`No branch or tag is called “${filter}”.`} />
          ) : null}
        </MetaContent>
      </div>
    </>
  );
}

function newBranchPrompt(from: string, start: string | null, initial = ""): PromptSpec {
  return {
    title: "New branch",
    detail: `Starts from ${from}.`,
    confirm: "Create and switch",
    fields: [
      { key: "name", label: "Name", placeholder: "feature/something", initial: refName(initial.trim()), transform: refName },
    ],
    onSubmit: ({ name }) => void workspace().createBranch(name ?? "", true, start),
  };
}

function BranchRow({
  branch,
  current,
  busy,
  web,
}: {
  branch: Branch;
  current: string | null;
  busy: boolean;
  web: string | null;
}) {
  const prompt = usePrompt();
  const checkout = () => {
    if (busy || branch.current) return;
    if (branch.remote) void workspace().checkoutRemote(branch.name);
    else void workspace().checkout(branch.name);
  };
  const entries = () => branchMenu(branch, current, web, prompt);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          aria-current={branch.current || undefined}
          title={branch.upstream ? `${branch.name} → ${branch.upstream}` : branch.name}
          className="k-row k-row-two group/branch gap-2.5"
          onClick={(event) => {
            if (!isControl(event.target)) checkout();
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              checkout();
            }
          }}
        >
          <span className="mt-[3px] shrink-0">
            {branch.current ? (
              <Check aria-hidden className="size-3.5 text-foreground" />
            ) : branch.remote ? (
              <Cloud aria-hidden className="size-3.5 text-faint" />
            ) : (
              <GitBranch aria-hidden className="size-3.5 text-faint" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5 leading-5">
              <span
                className={cn(
                  "min-w-0 truncate",
                  branch.current ? "font-medium text-foreground" : "text-dim",
                )}
              >
                {branch.name}
              </span>
              <BranchSync branch={branch} />
            </span>
            <span className="block truncate text-small leading-4 text-faint">
              {branch.subject || "—"}
              {branch.timestamp ? ` · ${relativeTime(branch.timestamp)}` : ""}
            </span>
          </span>
          <span className="mt-px hidden shrink-0 items-center gap-px group-hover/branch:flex group-focus-within/branch:flex">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`More for ${branch.name}`}
                  className="k-icon-btn size-[22px]"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Ellipsis className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto min-w-56">
                <DropdownMenuEntries entries={entries} />
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuEntries entries={entries} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function branchMenu(
  branch: Branch,
  current: string | null,
  web: string | null,
  prompt: (spec: PromptSpec) => void,
): MenuEntry[] {
  const state = workspace();
  const here = current ?? "HEAD";
  const local = branch.remote ? branch.name.slice(branch.name.indexOf("/") + 1) : branch.name;
  const entries: MenuEntry[] = [];
  if (!branch.current) {
    entries.push({
      kind: "item",
      label: branch.remote ? `Check out as ${local}` : "Check out",
      icon: LogIn,
      onSelect: () =>
        void (branch.remote ? state.checkoutRemote(branch.name) : state.checkout(branch.name)),
    });
  }
  entries.push({
    kind: "item",
    label: "New branch from here…",
    icon: GitBranchPlus,
    onSelect: () => prompt(newBranchPrompt(branch.name, branch.name)),
  });
  if (!branch.current && current) {
    entries.push(
      { kind: "separator" },
      {
        kind: "sub",
        label: `Merge into ${here}`,
        icon: GitMerge,
        entries: [
          { kind: "item", label: "Merge", onSelect: () => void state.merge(branch.name) },
          { kind: "item", label: "Merge, always with a merge commit", onSelect: () => void state.merge(branch.name, "no-ff") },
          { kind: "item", label: "Fast-forward only", onSelect: () => void state.merge(branch.name, "ff-only") },
          { kind: "item", label: "Squash into staged changes", onSelect: () => void state.merge(branch.name, "squash") },
        ],
      },
      {
        kind: "item",
        label: `Rebase ${here} onto this`,
        icon: GitPullRequestArrow,
        onSelect: () =>
          void ask(`Its commits will be rewritten on top of ${branch.name}.`, {
            title: `Rebase ${here} onto ${branch.name}?`,
            confirm: "Rebase",
            destructive: false,
          }).then((ok) => {
            if (ok) void state.rebase(branch.name);
          }),
      },
    );
  }
  entries.push({ kind: "separator" });
  if (!branch.remote) {
    if (branch.current) {
      entries.push({
        kind: "item",
        label: branch.upstream ? "Push" : "Publish",
        icon: Upload,
        onSelect: () => void state.push(),
      });
    }
    entries.push({
      kind: "item",
      label: "Rename…",
      icon: Pencil,
      onSelect: () =>
        prompt({
          title: "Rename branch",
          confirm: "Rename",
          fields: [{ key: "name", label: "New name", initial: branch.name, transform: refName }],
          onSubmit: ({ name }) => {
            if (name && name !== branch.name) void state.renameBranch(branch.name, name);
          },
        }),
    });
  }
  if (web) {
    entries.push({
      kind: "item",
      label: "Open on the web",
      icon: ExternalLink,
      disabled: !branch.remote && !branch.upstream,
      onSelect: () => void openUrl(`${web}/tree/${branch.remote ? local : (branch.upstream?.slice(branch.upstream.indexOf("/") + 1) ?? branch.name)}`).catch(() => {}),
    });
  }
  entries.push({ kind: "item", label: "Copy name", icon: Copy, onSelect: () => copy(branch.name, `Copied ${branch.name}`) });
  if (!branch.current) {
    entries.push(
      { kind: "separator" },
      branch.remote
        ? {
            kind: "item",
            label: "Delete from the remote",
            icon: Trash2,
            destructive: true,
            confirm: `Delete ${local} for everyone?`,
            onSelect: () => void state.deleteRemoteBranch(branch.name),
          }
        : {
            kind: "item",
            label: "Delete",
            icon: Trash2,
            destructive: true,
            confirm: `Delete ${branch.name}?`,
            onSelect: () => void state.deleteBranch(branch.name),
          },
    );
  }
  return entries;
}

function TagRow({ tag, busy }: { tag: GitTag; busy: boolean }) {
  const entries = (): MenuEntry[] => {
    const state = workspace();
    return [
      {
        kind: "item",
        label: "Check out",
        icon: LogIn,
        disabled: busy,
        onSelect: () => void state.checkoutRev(tag.hash),
      },
      { kind: "item", label: "Push to the remote", icon: ArrowUp, disabled: busy, onSelect: () => void state.pushTag(tag.name) },
      { kind: "item", label: "Copy name", icon: Copy, onSelect: () => copy(tag.name, `Copied ${tag.name}`) },
      { kind: "item", label: "Copy commit hash", onSelect: () => copy(tag.hash, "Copied the hash") },
      { kind: "separator" },
      {
        kind: "item",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        confirm: `Delete the tag ${tag.name}?`,
        onSelect: () => void state.deleteTag(tag.name),
      },
    ];
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          tabIndex={0}
          title={tag.subject || tag.name}
          className="k-row k-row-two group/tag gap-2.5"
        >
          <Tag aria-hidden className="mt-[3px] size-3.5 shrink-0 text-[color:var(--keel-working)]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate leading-5 text-dim">{tag.name}</span>
            <span className="block truncate text-small leading-4 text-faint">
              <span className="font-mono">{tag.hash.slice(0, 7)}</span>
              {tag.subject ? ` · ${tag.subject}` : ""}
              {tag.timestamp ? ` · ${relativeTime(tag.timestamp)}` : ""}
            </span>
          </span>
          <span className="mt-px hidden shrink-0 group-hover/tag:flex group-focus-within/tag:flex">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={`More for ${tag.name}`} className="k-icon-btn size-[22px]">
                  <Ellipsis className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto min-w-52">
                <DropdownMenuEntries entries={entries} />
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuEntries entries={entries} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
