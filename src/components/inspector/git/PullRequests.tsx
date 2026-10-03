/**
 * Pull requests, through the GitHub CLI.
 *
 * The one for the branch you are on comes first, as a card with its checks
 * and its review. Below it, the rest of the open ones; click one to check it
 * out. Opening a new one starts from the branch's latest commit.
 */

import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  GitPullRequestDraft,
  LogIn,
  Plus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { relativeTime } from "@/lib/git";
import { cn } from "@/lib/utils";
import type { GitStatus, PrChecks, PullRequest } from "@/lib/workspace";
import { useWorkspace } from "@/state/workspace";

import { Avatar, Empty, Hint, isControl, MetaContent, plural, Stat } from "./shared";

const workspace = useWorkspace.getState;

/** gh names bots `app/dependabot`; the part after the slash is the name. */
function authorName(login: string): string {
  return login.replace(/^app\//, "") || "unknown";
}

export function PullRequestsView({ git, busy }: { git: GitStatus; busy: boolean }) {
  const prs = useWorkspace((state) => state.prs);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    void workspace().refreshPrs();
  }, [git.branch]);

  const mine = prs?.items.find((pr) => pr.head === git.branch) ?? null;
  const others = prs?.items.filter((pr) => pr !== mine) ?? [];
  const canOpen = Boolean(git.branch) && !git.detached && !mine;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-3">
      <MetaContent section="prs" loaded={prs !== null} rows={4}>
        {prs && !prs.available ? (
          <Empty
            icon={GitPullRequest}
            title="GitHub CLI needed"
            detail={prs.error ?? "Install the GitHub CLI (gh) and sign in to see and open pull requests."}
          >
            <Button
              size="xs"
              variant="outline"
              className="mt-3"
              onClick={() => void openUrl("https://cli.github.com").catch(() => {})}
            >
              Get the GitHub CLI
            </Button>
          </Empty>
        ) : prs ? (
          <>
            {prs.error ? <Hint>{prs.error}</Hint> : null}
            {mine ? (
              <CurrentPr pr={mine} />
            ) : composing ? (
              <PrForm git={git} busy={busy} onDone={() => setComposing(false)} />
            ) : canOpen ? (
              <button
                type="button"
                disabled={busy || !git.upstream}
                onClick={() => setComposing(true)}
                title={git.upstream ? undefined : "Publish the branch first"}
                className="mx-[var(--keel-inset)] mb-2 flex w-[calc(100%-var(--keel-inset)*2)] items-center gap-2.5 rounded-[var(--keel-r-control)] bg-veil px-3 py-2.5 text-left hover:bg-veil-2 disabled:opacity-50"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-veil-2">
                  <Plus className="size-3.5 text-dim" />
                </span>
                <span className="min-w-0">
                  <span className="block text-body text-dim">Open a pull request</span>
                  <span className="block truncate text-small text-faint">
                    {git.upstream ? `From ${git.branch}` : "Publish this branch first"}
                  </span>
                </span>
              </button>
            ) : null}

            {others.length > 0 ? (
              <p className="k-label pb-1 pt-1.5">{mine || canOpen ? "Other open pull requests" : "Open pull requests"}</p>
            ) : !mine ? (
              <Empty icon={GitPullRequest} title="No open pull requests" />
            ) : null}
            {others.map((pr) => (
              <PrRow key={pr.number} pr={pr} busy={busy} />
            ))}
          </>
        ) : null}
      </MetaContent>
    </div>
  );
}

function PrIcon({ pr, className }: { pr: PullRequest; className?: string }) {
  const Icon = pr.draft ? GitPullRequestDraft : GitPullRequest;
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", pr.draft ? "text-faint" : "text-[color:var(--keel-done)]", className)}
    />
  );
}

function ChecksBadge({ checks }: { checks: PrChecks | null | undefined }) {
  if (!checks) return null;
  const total = checks.passed + checks.failed + checks.pending;
  const [Icon, tone, label] = checks.failed
    ? [CircleX, "var(--keel-dead)", `${checks.failed} of ${total} checks failed`]
    : checks.pending
      ? [CircleDashed, "var(--keel-working)", `${checks.pending} of ${total} checks running`]
      : [CircleCheck, "var(--keel-done)", `All ${total} checks passed`];
  return (
    <span title={label} className="flex shrink-0 items-center gap-1" style={{ color: tone }}>
      <Icon aria-label={label} className="size-3.5" />
    </span>
  );
}

const REVIEW_LABEL = {
  APPROVED: ["Approved", "var(--keel-done)"],
  CHANGES_REQUESTED: ["Changes requested", "var(--keel-dead)"],
  REVIEW_REQUIRED: ["Review required", "var(--keel-text-faint)"],
} as const;

function CurrentPr({ pr }: { pr: PullRequest }) {
  const review = pr.review ? REVIEW_LABEL[pr.review] : null;
  const checks = pr.checks;
  return (
    <div className="k-commit-card mx-[var(--keel-inset)] mb-2 mt-0 p-3">
      <div className="flex items-start gap-2.5">
        <PrIcon pr={pr} className="mt-[3px]" />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium leading-snug text-foreground">{pr.title}</p>
          <p className="mt-0.5 truncate text-small text-faint">
            <span className="tabular-nums">#{pr.number}</span> · {pr.head} → {pr.base}
            {pr.draft ? " · draft" : ""}
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {checks ? (
          <span className="k-tag gap-1.5">
            <ChecksBadge checks={checks} />
            {checks.failed
              ? `${checks.failed} failing`
              : checks.pending
                ? `${checks.pending} running`
                : `${checks.passed} passed`}
          </span>
        ) : null}
        {review ? (
          <span className="k-tag" style={{ color: review[1] }}>
            {review[0]}
          </span>
        ) : null}
        <Stat stat={{ added: pr.additions ?? 0, removed: pr.deletions ?? 0, binary: false }} />
        <span className="flex-1" />
        <Button size="xs" variant="outline" onClick={() => void openUrl(pr.url).catch(() => {})}>
          <ExternalLink className="size-3" />
          Open
        </Button>
      </div>
    </div>
  );
}

function PrRow({ pr, busy }: { pr: PullRequest; busy: boolean }) {
  const checkout = () => {
    if (!busy) void workspace().checkoutPr(pr.number);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      title={`Check out #${pr.number}`}
      className="k-row k-row-two group/pr gap-2.5"
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
      <PrIcon pr={pr} className="mt-[3px]" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5 leading-5">
          <span className="min-w-0 truncate text-dim">{pr.title}</span>
          <ChecksBadge checks={pr.checks} />
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-small leading-4 text-faint">
          <span className="shrink-0 tabular-nums">#{pr.number}</span>
          <span className="shrink-0">·</span>
          <Avatar name={authorName(pr.author)} />
          <span className="min-w-0 truncate" title={pr.head}>
            {authorName(pr.author)}
          </span>
          {pr.updatedAt ? (
            <span className="shrink-0">· {relativeTime(Date.parse(pr.updatedAt) / 1000)}</span>
          ) : null}
        </span>
      </span>
      <span className="mt-px hidden shrink-0 items-center gap-px group-hover/pr:flex group-focus-visible/pr:flex">
        <button
          type="button"
          title="Check out"
          aria-label="Check out"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            checkout();
          }}
          className="k-icon-btn size-[22px]"
        >
          <LogIn className="size-3" />
        </button>
        <button
          type="button"
          title="Open on GitHub"
          aria-label="Open on GitHub"
          onClick={(event) => {
            event.stopPropagation();
            void openUrl(pr.url).catch(() => {});
          }}
          className="k-icon-btn size-[22px]"
        >
          <ExternalLink className="size-3" />
        </button>
      </span>
    </div>
  );
}

function PrForm({ git, busy, onDone }: { git: GitStatus; busy: boolean; onDone: () => void }) {
  const commits = useWorkspace((state) => state.commits);
  const branches = useWorkspace((state) => state.branches);
  const [title, setTitle] = useState(() => commits?.[0]?.subject ?? "");
  const [body, setBody] = useState("");
  const [base, setBase] = useState<string | null>(null);
  const [draft, setDraft] = useState(false);

  useEffect(() => {
    if (!branches) void workspace().refreshBranches();
    // Start the title from the branch's latest commit, once the history is in.
    if (!commits) {
      void workspace()
        .refreshHistory()
        .then(() => {
          const subject = workspace().commits?.[0]?.subject;
          if (subject) setTitle((current) => current || subject);
        });
    }
  }, []);

  const bases = (branches?.items ?? [])
    .filter((branch) => branch.remote && !branch.name.endsWith(`/${git.branch}`))
    .map((branch) => branch.name.slice(branch.name.indexOf("/") + 1));

  return (
    <form
      className="mx-[var(--keel-inset)] mb-2 flex flex-col gap-1.5 rounded-[var(--keel-r-control)] bg-veil p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim() || busy) return;
        void workspace().createPr({ title: title.trim(), body, base, draft });
        onDone();
      }}
    >
      <p className="px-0.5 pb-0.5 text-small font-medium text-faint">
        New pull request from <span className="text-dim">{git.branch}</span>
      </p>
      <div className="k-field">
        <input
          autoFocus
          value={title}
          placeholder="Title"
          aria-label="Pull request title"
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="k-composer">
        <textarea
          rows={4}
          value={body}
          placeholder="What it changes, and why"
          aria-label="Pull request description"
          onChange={(event) => setBody(event.target.value)}
          className="pb-2"
        />
      </div>
      <div className="flex items-center gap-1.5 pt-0.5">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="k-field k-field-button k-field-sm min-w-0 flex-1">
              <GitBranch aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left text-body text-dim">
                into {base ?? "the default branch"}
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-auto min-w-52">
            <DropdownMenuItem onSelect={() => setBase(null)}>The default branch</DropdownMenuItem>
            {[...new Set(bases)].map((name) => (
              <DropdownMenuItem key={name} onSelect={() => setBase(name)}>
                {name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="k-seg shrink-0 p-[2px]">
          <button type="button" data-active={!draft} onClick={() => setDraft(false)} className="k-seg-btn h-[20px] px-2 text-small">
            Ready
          </button>
          <button type="button" data-active={draft} onClick={() => setDraft(true)} className="k-seg-btn h-[20px] px-2 text-small">
            Draft
          </button>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <span className="mr-auto text-small text-faint">
          {git.ahead ? `${plural(git.ahead, "commit")} not pushed yet` : ""}
        </span>
        <Button type="button" size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={busy || !title.trim()}>
          Open pull request
        </Button>
      </div>
    </form>
  );
}
