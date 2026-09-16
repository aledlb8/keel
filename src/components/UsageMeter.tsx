/**
 * Subscription quota, docked on the right of the footer.
 *
 * **The footer** holds one quiet cluster: for each signed-in login, a small
 * ring for the window that will stop you first, with the agent's mark inside
 * and the percentage beside it. The login your focused terminal is using reads
 * a step brighter. Colour only changes when it means something — amber from
 * 75% used, red from 90%.
 *
 * **The card** that opens on hover is the detail: every login, the one in use
 * first, each window with its reset countdown, and a marker on each bar for how
 * much of that window has already passed. A bar that runs well ahead of its
 * marker is on course to run out before it resets, and says so.
 *
 * The card never needs scrolling to compare logins and never grows past one
 * login's worth of detail. Every login starts folded to a single line that
 * still shows each window at a glance; clicking a line opens it and folds
 * whichever was open before.
 *
 * Nothing here ever waits in public. A login that has not answered, or answered
 * with an error, is not drawn at all until it has real numbers (see
 * `useAgentUsage`), and with none the cluster is gone — divider included.
 */

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { HoverCard } from "radix-ui";
import { ChevronDown, RefreshCw } from "lucide-react";

import { AgentMark } from "@/components/AgentMark";
import { sinceLabel } from "@/lib/island";
import { agentAccent } from "@/lib/tokens";
import { useAgentUsage } from "@/lib/useAgentUsage";
import {
  aheadOfPace,
  formatPercent,
  formatReset,
  profileLabel,
  tightestWindow,
  usageKey,
  usageLevel,
  windowElapsed,
  windowName,
  windowShortName,
  type AgentUsage,
  type UsageLevel,
  type UsageWindow,
} from "@/lib/usage";
import { cn } from "@/lib/utils";

const LEVEL_COLOR: Record<Exclude<UsageLevel, "ok">, string> = {
  warn: "var(--keel-working)",
  hot: "var(--keel-dead)",
};

function toneFor(used: number, accent: string): string {
  const level = usageLevel(used);
  return level === "ok" ? accent : LEVEL_COLOR[level];
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

interface Row {
  key: string;
  usage: AgentUsage;
  accent: string;
  profile: string;
  /** More than one login of this agent is on the bar. */
  showProfile: boolean;
  /** The focused terminal is signed in as this login. */
  active: boolean;
}

export function UsageMeter() {
  const { agents, fetching, fetchedAt, accounts, activeKey, refresh } =
    useAgentUsage();
  if (agents.length === 0) return null;

  const perAgent = new Map<string, number>();
  for (const usage of agents) {
    perAgent.set(usage.agentId, (perAgent.get(usage.agentId) ?? 0) + 1);
  }
  const rows: Row[] = agents.map((usage) => {
    const key = usageKey(usage.agentId, usage.accountId);
    return {
      key,
      usage,
      accent: agentAccent(usage.accent),
      profile: profileLabel(usage.accountId, accounts),
      showProfile: (perAgent.get(usage.agentId) ?? 0) > 1,
      active: key === activeKey,
    };
  });
  const inCard = [...rows].sort((a, b) => Number(b.active) - Number(a.active));

  const summary = rows
    .map((row) => {
      const tightest = tightestWindow(row.usage.windows);
      return `${row.usage.name}${row.showProfile ? ` ${row.profile}` : ""} ${formatPercent(tightest?.usedPercent ?? 0)} used`;
    })
    .join(", ");

  return (
    <>
      <span aria-hidden className="h-3.5 w-px bg-line" />
      <HoverCard.Root openDelay={120} closeDelay={120}>
        <HoverCard.Trigger asChild>
          <button
            type="button"
            aria-label={`Usage: ${summary}`}
            className="flex h-[22px] items-center rounded-[var(--keel-r-chip)] px-0.5 outline-none transition-colors duration-100 hover:bg-veil-2 focus-visible:bg-veil-2 data-[state=open]:bg-veil-2"
          >
            {rows.map((row, index) => (
              <Fragment key={row.key}>
                {index > 0 ? (
                  <span aria-hidden className="h-2.5 w-px shrink-0 bg-line" />
                ) : null}
                <Segment row={row} />
              </Fragment>
            ))}
          </button>
        </HoverCard.Trigger>

        <HoverCard.Portal>
          <HoverCard.Content
            side="top"
            align="end"
            sideOffset={10}
            collisionPadding={8}
            className={cn(
              "z-50 origin-(--radix-hover-card-content-transform-origin) outline-none duration-150",
              "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-1",
              "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            )}
          >
            <UsageCard
              rows={inCard}
              fetching={fetching}
              fetchedAt={fetchedAt}
              onRefresh={refresh}
            />
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>
    </>
  );
}

/** One login on the footer: ring, mark, percentage. */
function Segment({ row }: { row: Row }) {
  const tightest = tightestWindow(row.usage.windows);
  const used = clampPercent(tightest?.usedPercent ?? 0);
  const level = usageLevel(used);

  return (
    <span className="flex items-center gap-1.5 px-1.5 animate-in fade-in-0 zoom-in-95 duration-300">
      <Ring percent={used} color={toneFor(used, row.accent)}>
        <AgentMark
          agentId={row.usage.agentId}
          name={row.usage.name}
          accent={row.accent}
          size={8}
          variant="glyph"
          muted={!row.active}
        />
      </Ring>
      {row.showProfile ? (
        <span
          className={cn(
            "max-w-16 truncate text-[11px] leading-none",
            row.active ? "text-dim" : "text-faint",
          )}
        >
          {row.profile}
        </span>
      ) : null}
      <span
        className={cn(
          "text-[11px] font-medium tabular-nums leading-none",
          level === "ok" && (row.active ? "text-dim" : "text-faint"),
        )}
        style={level === "ok" ? undefined : { color: LEVEL_COLOR[level] }}
      >
        {formatPercent(used)}
      </span>
    </span>
  );
}

/** A 16px progress ring with the agent's mark in the middle. */
function Ring({
  percent,
  color,
  children,
}: {
  percent: number;
  color: string;
  children: ReactNode;
}) {
  const size = 16;
  const stroke = 1.75;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clampPercent(percent) / 100);

  return (
    <span className="relative grid size-4 shrink-0 place-items-center">
      {children}
      <svg
        aria-hidden
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="absolute inset-0 -rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--keel-veil-3)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
    </span>
  );
}

function UsageCard({
  rows,
  fetching,
  fetchedAt,
  onRefresh,
}: {
  rows: Row[];
  fetching: boolean;
  fetchedAt: number | null;
  onRefresh: () => void;
}) {
  const now = useNow();
  // Everything starts folded; at most one login is open at a time.
  const folding = true;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const isOpen = (row: Row) => row.key === openKey;
  const anyMarker = rows.some(
    (row) =>
      isOpen(row) &&
      row.usage.windows.some((window) => windowElapsed(window, now) !== null),
  );

  return (
    <div className="w-[348px] overflow-hidden rounded-[var(--keel-r-window)] border border-line-strong bg-popover text-foreground shadow-[var(--keel-lift-strong)]">
      <header className="flex h-11 items-center gap-2 pl-4 pr-2">
        <h2 className="text-[13px] font-semibold tracking-[-0.01em]">Usage</h2>
        {fetchedAt ? (
          <span className="text-[11px] text-faint">
            Updated {sinceLabel(fetchedAt, now)}
          </span>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onRefresh}
          disabled={fetching}
          title="Refresh now"
          aria-label="Refresh usage"
          className="k-icon-btn size-7 disabled:pointer-events-none"
        >
          <RefreshCw className={cn("size-3.5", fetching && "animate-spin")} />
        </button>
      </header>

      <div className="flex max-h-[min(520px,72vh)] flex-col gap-1 overflow-y-auto px-1.5">
        {rows.map((row) => (
          <Login
            key={row.key}
            row={row}
            now={now}
            open={isOpen(row)}
            onToggle={
              folding
                ? () => setOpenKey((key) => (key === row.key ? null : row.key))
                : undefined
            }
          />
        ))}
      </div>

      {anyMarker ? (
        <footer className="flex items-center gap-2 px-4 pb-3 pt-2.5 text-[11px] text-faint">
          <span aria-hidden className="h-2.5 w-[2px] rounded-full bg-foreground/60" />
          How much of each window has passed
        </footer>
      ) : (
        <div className="h-1.5" />
      )}
    </div>
  );
}

function Login({
  row,
  now,
  open,
  onToggle,
}: {
  row: Row;
  now: number;
  open: boolean;
  /** Present when this login folds; absent when every login stays open. */
  onToggle?: (() => void) | undefined;
}) {
  const { usage } = row;

  const heading = (
    <>
      <AgentMark
        agentId={usage.agentId}
        name={usage.name}
        accent={row.accent}
        size={22}
      />
      <span
        className="min-w-0 flex-1 truncate text-left text-[13px] font-medium"
        title={row.showProfile ? `${usage.name} ${row.profile}` : usage.name}
      >
        {open || !row.showProfile ? (
          <>
            {usage.name}
            {row.showProfile ? (
              <span className="ml-1.5 font-normal text-faint">{row.profile}</span>
            ) : null}
          </>
        ) : (
          // Folded, the mark already says which agent; the profile is what
          // tells four Claude logins apart.
          row.profile
        )}
      </span>
      {open ? (
        <span className="flex shrink-0 items-center gap-1.5 animate-in fade-in-0 duration-200">
          {row.active ? <Tag strong>In use</Tag> : null}
          {usage.plan ? <Tag>{usage.plan}</Tag> : null}
        </span>
      ) : (
        <Glance windows={usage.windows} accent={row.accent} />
      )}
      {onToggle ? (
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-faint transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      ) : null}
    </>
  );

  return (
    <section
      className={cn(
        "rounded-[var(--keel-r-control)] transition-colors duration-150",
        row.active
          ? "bg-veil-2 shadow-[inset_0_1px_0_0_var(--keel-sheen)]"
          : "bg-veil",
      )}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex h-11 w-full items-center gap-2.5 rounded-[var(--keel-r-control)] px-3 outline-none transition-colors hover:bg-veil focus-visible:bg-veil-2"
        >
          {heading}
        </button>
      ) : (
        <div className="flex h-11 items-center gap-2.5 px-3">{heading}</div>
      )}

      {/* Rows animate open by height without measuring: 0fr → 1fr. */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <ul
            className={cn(
              "flex flex-col gap-3 px-3 pb-3 pt-0.5 transition-opacity duration-200",
              open ? "opacity-100" : "opacity-0",
            )}
            aria-hidden={!open}
          >
            {usage.windows.map((window) => (
              <WindowRow
                key={window.label}
                window={window}
                accent={row.accent}
                now={now}
              />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/**
 * Every window of a folded login on one line: "5h ▬ 42%  Wk ▬ 81%". Enough to
 * compare logins without opening them; the two tightest if there are more.
 */
function Glance({ windows, accent }: { windows: UsageWindow[]; accent: string }) {
  const shown =
    windows.length > 2
      ? [...windows]
          .sort((a, b) => b.usedPercent - a.usedPercent)
          .slice(0, 2)
          .sort((a, b) => windows.indexOf(a) - windows.indexOf(b))
      : windows;

  return (
    <span className="flex shrink-0 items-center gap-3 animate-in fade-in-0 duration-200">
      {shown.map((window) => {
        const used = clampPercent(window.usedPercent);
        const level = usageLevel(used);
        return (
          <span key={window.label} className="flex items-center gap-1.5">
            <span className="text-[10px] font-medium text-faint">
              {windowShortName(window.label)}
            </span>
            <span className="h-[3px] w-6 overflow-hidden rounded-full bg-veil-3">
              <span
                className="block h-full rounded-full"
                style={{
                  width: used > 0 ? `max(${used}%, 3px)` : 0,
                  background: toneFor(used, accent),
                }}
              />
            </span>
            <span
              className={cn(
                "w-7 text-right text-[11px] font-medium tabular-nums",
                level === "ok" && "text-dim",
              )}
              style={level === "ok" ? undefined : { color: LEVEL_COLOR[level] }}
            >
              {formatPercent(used)}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function WindowRow({
  window,
  accent,
  now,
}: {
  window: UsageWindow;
  accent: string;
  now: number;
}) {
  const used = clampPercent(window.usedPercent);
  const level = usageLevel(used);
  const tone = toneFor(used, accent);
  const reset = formatReset(window.resetsAt, now);
  const elapsed = windowElapsed(window, now);
  const ahead = aheadOfPace(window, now);

  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-3">
        <span className="flex-1 text-[12px] text-dim">{windowName(window.label)}</span>
        <span
          className={cn(
            "text-[12px] font-semibold tabular-nums",
            level === "ok" && "text-foreground",
          )}
          style={level === "ok" ? undefined : { color: LEVEL_COLOR[level] }}
        >
          {formatPercent(used)}
        </span>
      </div>

      <div className="relative h-1.5 rounded-full bg-veil-3">
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{
            width: used > 0 ? `max(${used}%, 6px)` : 0,
            background: tone,
          }}
        />
        {elapsed !== null ? (
          <span
            aria-hidden
            title={`${Math.round(elapsed * 100)}% of this window has passed`}
            className="absolute -bottom-[3px] -top-[3px] w-[2px] -translate-x-1/2 rounded-full bg-foreground/60"
            style={{ left: `${elapsed * 100}%` }}
          />
        ) : null}
      </div>

      {reset || ahead ? (
        <div className="flex items-center gap-3 text-[11px] text-faint">
          <span className="flex-1">
            {reset === "now" ? "Resetting now" : reset ? `Resets in ${reset}` : ""}
          </span>
          {ahead ? (
            <span style={{ color: "var(--keel-working)" }}>Ahead of pace</span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Tag({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-[3px] text-[10px] font-medium leading-none",
        // Plans arrive lower-case ("max"); "In use" is already written right.
        strong ? "bg-veil-3 text-foreground" : "bg-veil-2 capitalize text-dim",
      )}
    >
      {children}
    </span>
  );
}

/** A clock for countdowns, ticking while the card is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
