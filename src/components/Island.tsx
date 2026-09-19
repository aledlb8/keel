/**
 * The island: the pill in the middle of the top bar.
 *
 * At rest it says where you are. It grows to say the one thing that needs you —
 * an agent finished, terminals are coming back, the tunnel is coming up, the
 * host stopped answering — and it takes you there when you click it. Click it
 * at rest and a switcher drops out of it: every waiting and working agent, every
 * terminal, deck, project and workspace, and the app's actions, a few keystrokes
 * away.
 *
 * Rules that keep it from turning into a notification centre:
 *
 *  - **One thing at a time.** System states outrank agents; the most urgent
 *    wins and the rest wait their turn.
 *  - **News, not state.** An agent finishing grows the island once and then it
 *    settles into a count. Nothing repeats, and hovering holds it open.
 *  - **Never about what you are looking at.** An agent that finishes in the pane
 *    you have focused was never waiting for you (see the store's tracker).
 *  - **It always goes somewhere.** Every message is also the button that acts on
 *    it, and both have a key: F8 for the next waiting agent, Ctrl+P for the
 *    switcher.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Popover } from "radix-ui";
import {
  ArrowUpRight,
  FileSearch,
  FolderOpen,
  FolderPlus,
  Keyboard,
  LayoutGrid,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  ShieldCheck,
  SquareTerminal,
  UsersRound,
} from "lucide-react";

import { AgentMark } from "@/components/AgentMark";
import type { TitlebarActions } from "@/components/Titlebar";
import { StatusLight } from "@/components/VpnDialog";
import { WorkspaceGlyph, WorkspaceMark } from "@/components/WorkspaceMark";
import * as backend from "@/lib/backend";
import {
  lookingAt,
  paneRefs,
  rankBy,
  sinceLabel,
  systemMoment,
  waitingPanes,
  workingPanes,
  type PaneRef,
  type WaitingPane,
} from "@/lib/island";
import { shortcutKeys, withShortcut } from "@/lib/keymap";
import { monogram } from "@/lib/monogram";
import { agentAccent } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import type { Agent } from "@/lib/types";
import { orderedProjects, workspaceOf } from "@/lib/workspaces";
import { useKeel } from "@/state/store";

/** How long each kind of news keeps the island grown, once you stop hovering. */
const HOLD_MS = { arrival: 6_000, "vpn-connected": 2_600, nudge: 1_600 };

type News = { kind: keyof typeof HOLD_MS; at: number };

/**
 * Put the caret in a pane's terminal once its deck is on screen. A terminal on a
 * hidden deck cannot take focus, so this waits for the switch to paint.
 */
export function focusTerminal(paneId: string | null | undefined) {
  if (!paneId) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `[data-pane="${CSS.escape(paneId)}"] .xterm-helper-textarea`,
        )
        ?.focus();
    }),
  );
}

function whereOf(ref: PaneRef): string {
  return ref.deckCount > 1 ? `${ref.projectName} / ${ref.deckName}` : ref.projectName;
}

export interface IslandProps {
  actions: TitlebarActions;
  /** Called after the island moves you somewhere, so covering views can lift. */
  onNavigate: () => void;
}

export function Island({ actions, onNavigate }: IslandProps) {
  const projects = useKeel((state) => state.projects);
  const workspaces = useKeel((state) => state.workspaces);
  const activeProjectId = useKeel((state) => state.activeProjectId);
  const status = useKeel((state) => state.status);
  const doneAt = useKeel((state) => state.doneAt);
  const agents = useKeel((state) => state.agents);
  const hostLost = useKeel((state) => state.hostLost);
  const restoreStatus = useKeel((state) => state.restoreStatus);
  const restoreLeft = useKeel((state) => state.restoreLeft);
  const restoreTotal = useKeel(
    (state) => Object.keys(state.restorePanes).length,
  );
  const vpnPhase = useKeel((state) => state.vpn.phase);
  const vpnProfile = useKeel((state) => state.vpn.profileName);
  const switcher = useKeel((state) => state.switcher);
  const setSwitcher = useKeel((state) => state.setSwitcher);
  const nudge = useKeel((state) => state.islandNudge);

  const project = projects.find((item) => item.id === activeProjectId) ?? null;
  const group = project ? workspaceOf(workspaces, project.id) : null;
  const deck = project
    ? (project.decks.find((item) => item.id === project.activeDeckId) ??
      project.decks[0] ??
      null)
    : null;
  const watching = lookingAt(projects, activeProjectId);

  const waiting = useMemo(
    () => waitingPanes(projects, status, doneAt, watching),
    [projects, status, doneAt, watching],
  );
  const working = useMemo(
    () => workingPanes(projects, status),
    [projects, status],
  );
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  const system = systemMoment({
    hostLost,
    restoring: restoreStatus === "restoring",
    restoreLeft,
    restoreTotal,
    vpnConnecting: vpnPhase === "connecting",
  });

  // ---- News ----------------------------------------------------------------

  const [news, setNews] = useState<News | null>(null);
  const [hovered, setHovered] = useState(false);

  // Anything that finished before the island mounted is state, not news.
  const newestSeen = useRef(Date.now());
  useEffect(() => {
    const newest = waiting.reduce((max, entry) => Math.max(max, entry.since), 0);
    if (newest > newestSeen.current) {
      newestSeen.current = newest;
      setNews({ kind: "arrival", at: Date.now() });
    }
    // Once nobody is waiting, an arrival has nothing left to say.
    if (waiting.length === 0) {
      setNews((current) => (current?.kind === "arrival" ? null : current));
    }
  }, [waiting]);

  const previousPhase = useRef(vpnPhase);
  useEffect(() => {
    if (previousPhase.current === "connecting" && vpnPhase === "connected") {
      setNews({ kind: "vpn-connected", at: Date.now() });
    }
    previousPhase.current = vpnPhase;
  }, [vpnPhase]);

  const previousNudge = useRef(nudge);
  useEffect(() => {
    if (nudge === previousNudge.current) return;
    previousNudge.current = nudge;
    setNews({ kind: "nudge", at: Date.now() });
  }, [nudge]);

  useEffect(() => {
    if (!news || hovered || switcher) return;
    const timer = setTimeout(() => setNews(null), HOLD_MS[news.kind]);
    return () => clearTimeout(timer);
  }, [news, hovered, switcher]);

  // ---- Actions -------------------------------------------------------------

  function jump(paneId: string) {
    const moved = useKeel.getState().jumpToPane(paneId);
    setNews(null);
    setSwitcher(false);
    if (!moved) return;
    onNavigate();
    focusTerminal(paneId);
  }

  function retryHost() {
    void backend
      .detectAgents()
      .then(() => useKeel.getState().clearHostLost())
      .catch(() => {
        /* Stay lost until a call succeeds. */
      });
  }

  // ---- What the island says ------------------------------------------------

  const moment = system
    ? system.kind
    : switcher
      ? "rest"
      : (news?.kind ?? "rest");

  const lead = waiting[0] ?? null;
  const leadAgent = lead?.agentId ? agentById.get(lead.agentId) : undefined;
  const accent =
    moment === "arrival"
      ? agentAccent(leadAgent?.accent)
      : moment === "host-lost"
        ? "var(--keel-dead)"
        : "var(--keel-done)";

  let content: ReactNode;
  let contentKey: string = moment;
  let label: string;

  switch (moment) {
    case "host-lost":
      label = "Keel isn't responding. Terminals keep running.";
      content = (
        <span className="flex h-full items-center gap-2.5 pl-3 pr-[3px]">
          <StatusLight tone="error" color="var(--keel-dead)" size={7} />
          <span className="text-body font-medium text-foreground">
            Keel isn&apos;t responding
          </span>
          <span className="text-body text-faint">Terminals keep running</span>
          <IslandChip onClick={retryHost}>Retry</IslandChip>
        </span>
      );
      break;

    case "restoring": {
      const progress = system?.kind === "restoring" ? system : null;
      label = "Reopening terminals";
      content = (
        <span className="flex h-full items-center gap-2.5 px-3">
          <LoaderCircle className="size-3.5 animate-spin text-faint" />
          <span className="text-body text-dim">Reopening terminals</span>
          {progress && progress.total > 0 ? (
            <span className="text-body tabular-nums text-faint">
              {progress.done} of {progress.total}
            </span>
          ) : null}
        </span>
      );
      break;
    }

    case "vpn-connecting":
      label = "Connecting VPN";
      content = (
        <button
          type="button"
          onClick={actions.openVpn}
          className="flex h-full items-center gap-2.5 px-3 outline-none"
        >
          <StatusLight tone="connecting" color="var(--keel-working)" size={7} />
          <span className="text-body text-dim">Connecting VPN</span>
          {vpnProfile ? (
            <span className="max-w-[180px] truncate text-body text-faint">
              {vpnProfile}
            </span>
          ) : null}
        </button>
      );
      break;

    case "vpn-connected":
      label = "VPN connected";
      content = (
        <button
          type="button"
          onClick={actions.openVpn}
          className="flex h-full items-center gap-2 px-3 outline-none"
        >
          <ShieldCheck
            className="size-3.5"
            style={{ color: "var(--keel-done)" }}
          />
          <span className="text-body text-dim">VPN connected</span>
          {vpnProfile ? (
            <span className="max-w-[180px] truncate text-body text-faint">
              {vpnProfile}
            </span>
          ) : null}
        </button>
      );
      break;

    case "nudge":
      label = "No agents waiting";
      content = (
        <span className="flex h-full items-center gap-2 px-3.5">
          <span className="text-body text-faint">No agents waiting</span>
        </span>
      );
      break;

    case "arrival": {
      if (!lead) {
        label = "";
        content = null;
        break;
      }
      const many = waiting.length > 1;
      contentKey = many ? `arrival:${waiting.length}` : `arrival:${lead.paneId}`;
      label = many
        ? `${waiting.length} agents waiting`
        : `${leadAgent?.name ?? lead.title} finished in ${whereOf(lead)}`;
      content = (
        <button
          type="button"
          onClick={() => jump(lead.paneId)}
          title={withShortcut(
            many ? "Go to the one waiting longest" : "Go to it",
            "nextWaiting",
          )}
          className="flex h-full items-center gap-2.5 pl-1 pr-[3px] outline-none"
        >
          <MarkStack panes={waiting.slice(-3).reverse()} agentById={agentById} />
          <span className="text-body font-medium text-foreground">
            {many
              ? `${waiting.length} agents waiting`
              : `${leadAgent?.name ?? "Shell"} finished`}
          </span>
          <span className="max-w-[220px] truncate text-body text-faint">
            {many ? `longest in ${lead.projectName}` : `in ${whereOf(lead)}`}
          </span>
          <span className="flex h-5 items-center gap-1 rounded-full bg-foreground pl-2 pr-1.5 text-small font-medium text-background">
            Jump
            <ArrowUpRight className="size-3" />
          </span>
        </button>
      );
      break;
    }

    default:
      label = project
        ? `${group ? `${group.name} / ` : ""}${project.name}${project.decks.length > 1 && deck ? `, ${deck.name}` : ""}`
        : "Go to";
      content = (
        <span className="flex h-full items-center">
          <button
            type="button"
            onClick={() => setSwitcher(!switcher)}
            title={withShortcut("Go to…", "goTo")}
            aria-haspopup="dialog"
            aria-expanded={switcher}
            className="group/rest flex h-full min-w-0 items-center gap-2.5 px-3 outline-none"
          >
            {project ? (
              <>
                {/* The group is a badge, not a crumb. Two names either side of
                    a rule read as a trail you are halfway along; the mark says
                    which workspace you are scoped to and leaves the project as
                    the place you are. Its name is in the title, one hover
                    away. */}
                <span className="flex min-w-0 items-center gap-2">
                  {group ? <WorkspaceMark name={group.name} size={16} /> : null}
                  <span className="max-w-[220px] truncate text-body text-dim transition-colors group-hover/rest:text-foreground">
                    {project.name}
                  </span>
                </span>
                {project.decks.length > 1 && deck ? (
                  <>
                    <span
                      aria-hidden
                      className="h-3 w-px shrink-0 bg-line-strong"
                    />
                    <span className="max-w-[160px] truncate text-body text-faint transition-colors group-hover/rest:text-dim">
                      {deck.name}
                    </span>
                  </>
                ) : null}
              </>
            ) : (
              <span className="flex items-center gap-1.5 text-body text-faint transition-colors group-hover/rest:text-dim">
                <Search className="size-3" />
                Go to…
              </span>
            )}
          </button>
          {waiting.length > 0 ? (
            <button
              type="button"
              onClick={() => lead && jump(lead.paneId)}
              title={withShortcut(
                `${waiting.length} waiting. Go to the longest`,
                "nextWaiting",
              )}
              aria-label={`${waiting.length} agents waiting`}
              className="-ml-1 mr-[3px] flex h-5 items-center gap-1.5 rounded-full pl-1.5 pr-2 text-small font-semibold tabular-nums outline-none transition-[filter] hover:brightness-125"
              style={{
                color: "var(--keel-done)",
                background:
                  "color-mix(in srgb, var(--keel-done) 15%, transparent)",
              }}
            >
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-[color:var(--keel-done)]"
              />
              {waiting.length}
            </button>
          ) : null}
        </span>
      );
  }

  // ---- Shape ---------------------------------------------------------------

  const measure = useRef<HTMLSpanElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  // Layout width, not the painted box: new content arrives scaled down, and
  // measuring mid-animation left the pill a few pixels short for good.
  const remeasure = useCallback(() => {
    if (measure.current) setWidth(measure.current.offsetWidth);
  }, []);
  // Every new message is measured before it paints, so the pill never waits a
  // frame on the observer — which could miss a quick pair of changes entirely.
  useLayoutEffect(remeasure, [contentKey, label, remeasure]);
  // The observer catches what the message key does not, like a font arriving.
  useLayoutEffect(() => {
    const element = measure.current;
    if (!element) return;
    const observer = new ResizeObserver(remeasure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [remeasure]);

  const shape: CSSProperties & Record<"--island-accent", string> = {
    width: width ?? undefined,
    "--island-accent": accent,
  };

  const restoreShare =
    system?.kind === "restoring" && system.total > 0
      ? system.done / system.total
      : null;

  return (
    <Popover.Root open={switcher} onOpenChange={setSwitcher}>
      <Popover.Anchor asChild>
        <div
          role="status"
          aria-live="polite"
          aria-label={label}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          data-moment={moment}
          className={cn(
            "k-island relative h-[var(--keel-h-control)] max-w-full shrink-0 overflow-hidden rounded-full",
            moment === "host-lost"
              ? "bg-[color:color-mix(in_srgb,var(--keel-dead)_14%,transparent)]"
              : moment === "rest"
                ? "bg-veil-2 hover:bg-veil-3"
                : "bg-veil-3",
            moment === "nudge" && "k-island-shake",
          )}
          style={shape}
        >
          <span
            ref={measure}
            className="absolute left-0 top-0 flex h-full w-max items-center"
          >
            <span key={contentKey} className="k-island-swap flex h-full items-center">
              {content}
            </span>
          </span>

          {moment === "arrival" ? (
            <span key={`glow:${news?.at}`} aria-hidden className="k-island-glow" />
          ) : null}

          {moment === "rest" && working.length > 0 ? (
            <span
              aria-hidden
              title={`${working.length} working`}
              className="k-island-scan"
            />
          ) : null}

          {restoreShare !== null ? (
            <span aria-hidden className="absolute inset-x-3 bottom-0 h-px bg-veil-3">
              <span
                className="block h-full bg-foreground/60 transition-[width] duration-500 ease-out"
                style={{ width: `${Math.round(restoreShare * 100)}%` }}
              />
            </span>
          ) : null}
        </div>
      </Popover.Anchor>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          onCloseAutoFocus={(event) => {
            // Back to the terminal you were in, not to the pill.
            event.preventDefault();
            focusTerminal(lookingAt(
              useKeel.getState().projects,
              useKeel.getState().activeProjectId,
            ));
          }}
          className={cn(
            "z-50 origin-(--radix-popover-content-transform-origin) outline-none",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-2",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            "duration-150",
          )}
        >
          <Switcher
            waiting={waiting}
            working={working}
            agentById={agentById}
            actions={actions}
            hasProject={project !== null}
            activeProjectId={activeProjectId}
            onJump={jump}
            onClose={() => setSwitcher(false)}
            onNavigate={onNavigate}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function IslandChip({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-5 items-center rounded-full bg-foreground px-2.5 text-small font-medium text-background outline-none transition-opacity hover:opacity-85"
    >
      {children}
    </button>
  );
}

/** Up to three agent marks, overlapping like a hand of cards. */
function MarkStack({
  panes,
  agentById,
}: {
  panes: WaitingPane[];
  agentById: Map<string, Agent>;
}) {
  return (
    <span className="flex items-center pl-0.5">
      {panes.map((entry, index) => {
        const agent = entry.agentId ? agentById.get(entry.agentId) : undefined;
        return (
          <span
            key={entry.paneId}
            className={cn("rounded-[7px]", index > 0 && "-ml-[5px]")}
            style={{
              zIndex: panes.length - index,
              // Cut out of the pill's own fill, so each card reads as lying on it.
              boxShadow: "0 0 0 1.5px color-mix(in srgb, #fff 12%, var(--keel-chrome))",
            }}
          >
            <AgentMark
              agentId={entry.agentId}
              name={agent?.name}
              accent={agentAccent(agent?.accent)}
              size={20}
              className="bg-[color:var(--keel-chrome-strong)]"
            />
          </span>
        );
      })}
    </span>
  );
}

// ---- Switcher --------------------------------------------------------------

const GROUPS = [
  "Waiting",
  "Working",
  "Terminals",
  "Decks",
  "Workspaces",
  "Projects",
  "Actions",
] as const;

type Group = (typeof GROUPS)[number];

interface Entry {
  id: string;
  group: Group;
  label: string;
  detail?: string;
  search: string[];
  leading: ReactNode;
  trailing?: ReactNode;
  run: () => void;
}

/** How many of each group show before you type. Typing searches all of them. */
const RESTING_LIMIT: Record<Group, number> = {
  Waiting: 99,
  Working: 99,
  Terminals: 6,
  Decks: 9,
  Workspaces: 6,
  Projects: 6,
  Actions: 99,
};

function Switcher({
  waiting,
  working,
  agentById,
  actions,
  hasProject,
  activeProjectId,
  onJump,
  onClose,
  onNavigate,
}: {
  waiting: WaitingPane[];
  working: PaneRef[];
  agentById: Map<string, Agent>;
  actions: TitlebarActions;
  hasProject: boolean;
  activeProjectId: string | null;
  onJump: (paneId: string) => void;
  onClose: () => void;
  onNavigate: () => void;
}) {
  const projects = useKeel((state) => state.projects);
  const workspaces = useKeel((state) => state.workspaces);
  const sidebar = useKeel((state) => state.sidebar);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const list = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const entries = useMemo<Entry[]>(() => {
    const mark = (ref: PaneRef) => {
      const agent = ref.agentId ? agentById.get(ref.agentId) : undefined;
      return (
        <AgentMark
          agentId={ref.agentId}
          name={agent?.name}
          accent={agentAccent(agent?.accent)}
          size={24}
        />
      );
    };
    const paneEntry = (ref: PaneRef, group: Group, trailing?: ReactNode): Entry => {
      const agent = ref.agentId ? agentById.get(ref.agentId) : undefined;
      return {
        id: `pane:${ref.paneId}`,
        group,
        label: ref.title,
        detail: whereOf(ref),
        search: [ref.title, agent?.name ?? "shell", ref.projectName, ref.deckName],
        leading: mark(ref),
        trailing,
        run: () => onJump(ref.paneId),
      };
    };

    const busy = new Set([
      ...waiting.map((entry) => entry.paneId),
      ...working.map((entry) => entry.paneId),
    ]);

    const result: Entry[] = [
      ...waiting.map((entry) =>
        paneEntry(
          entry,
          "Waiting",
          <span className="flex items-center gap-1.5 text-small text-dim">
            <span className="size-1.5 rounded-full bg-[color:var(--keel-done)]" />
            {sinceLabel(entry.since, now)}
          </span>,
        ),
      ),
      ...working.map((entry) =>
        paneEntry(
          entry,
          "Working",
          <span className="flex items-center gap-2 text-small text-faint">
            <StatusLight tone="connecting" color="var(--keel-working)" size={6} />
            Working
          </span>,
        ),
      ),
    ];

    const listed = orderedProjects(projects, workspaces, sidebar);
    const restingProject = query.trim() ? null : activeProjectId;
    for (const ref of paneRefs(listed)) {
      if (busy.has(ref.paneId)) continue;
      if (restingProject && ref.projectId !== restingProject) continue;
      result.push(paneEntry(ref, "Terminals"));
    }

    for (const project of listed) {
      if (project.decks.length < 2) continue;
      if (restingProject && project.id !== restingProject) continue;
      project.decks.forEach((deck, index) => {
        const count = Object.keys(deck.panes).length;
        const current =
          project.id === activeProjectId && deck.id === project.activeDeckId;
        result.push({
          id: `deck:${deck.id}`,
          group: "Decks",
          label: deck.name,
          detail: project.name,
          search: [deck.name, project.name, String(index + 1)],
          leading: (
            <Tile>
              <span className="text-small font-semibold tabular-nums">
                {index + 1}
              </span>
            </Tile>
          ),
          trailing: (
            <span className="text-small text-faint">
              {current ? "Current" : `${count} ${count === 1 ? "terminal" : "terminals"}`}
            </span>
          ),
          run: () => {
            const state = useKeel.getState();
            state.selectProject(project.id);
            state.selectDeck(project.id, deck.id);
            onClose();
            onNavigate();
          },
        });
      });
    }

    for (const workspace of workspaces) {
      if (!query.trim() && workspace.projectIds.includes(activeProjectId ?? "")) {
        continue;
      }
      const count = workspace.projectIds.length;
      result.push({
        id: `workspace:${workspace.id}`,
        group: "Workspaces",
        label: workspace.name,
        detail: count
          ? `${count} ${count === 1 ? "project" : "projects"}`
          : "Empty",
        search: [
          workspace.name,
          ...workspace.projectIds.flatMap((id) => {
            const project = projects.find((item) => item.id === id);
            return project ? [project.name, project.path] : [];
          }),
        ],
        leading: <Tile>{monogram(workspace.name)}</Tile>,
        trailing: (
          <span className="text-small text-faint">
            {workspace.projectIds.includes(activeProjectId ?? "")
              ? "Current"
              : count
                ? `${count} ${count === 1 ? "project" : "projects"}`
                : "Empty"}
          </span>
        ),
        run: () => {
          useKeel.getState().selectWorkspace(workspace.id);
          onClose();
          onNavigate();
        },
      });
    }

    for (const project of listed) {
      if (!query.trim() && project.id === activeProjectId) continue;
      const count = project.decks.reduce(
        (total, deck) => total + Object.keys(deck.panes).length,
        0,
      );
      const group = workspaceOf(workspaces, project.id);
      result.push({
        id: `project:${project.id}`,
        group: "Projects",
        label: project.name,
        detail: group ? group.name : project.path,
        search: [project.name, project.path, group?.name ?? ""],
        leading: (
          <Tile>
            <FolderOpen className="size-3.5" />
          </Tile>
        ),
        trailing: (
          <span className="text-small text-faint">
            {project.id === activeProjectId
              ? "Current"
              : `${count} ${count === 1 ? "terminal" : "terminals"}`}
          </span>
        ),
        run: () => {
          useKeel.getState().selectProject(project.id);
          onClose();
          onNavigate();
        },
      });
    }

    const action = (
      id: string,
      label: string,
      icon: ReactNode,
      run: () => void,
      keys?: string,
    ): Entry => ({
      id: `action:${id}`,
      group: "Actions",
      label,
      search: [label],
      leading: <Tile>{icon}</Tile>,
      trailing: keys ? <Keys>{keys}</Keys> : undefined,
      run: () => {
        onClose();
        run();
      },
    });

    result.push(
      ...(hasProject
        ? [
            action("terminals", "Add terminals", <Plus className="size-3.5" />, actions.addTerminals, shortcutKeys("addTerminals")),
            action("deck", "New deck", <SquareTerminal className="size-3.5" />, actions.newDeck, shortcutKeys("newDeck")),
            action("overview", "Overview of every deck", <LayoutGrid className="size-3.5" />, actions.showOverview, shortcutKeys("overview")),
          ]
        : []),
      action("folder", "Add a folder", <FolderPlus className="size-3.5" />, actions.addFolder),
      action("workspace", "New workspace", <WorkspaceGlyph className="size-3.5" />, actions.addWorkspace),
      action("agents", "Agents & profiles", <UsersRound className="size-3.5" />, actions.openCatalogue),
      action("vpn", "Private VPN", <ShieldCheck className="size-3.5" />, actions.openVpn),
      action("sidebar", "Collapse or expand the sidebar", <PanelLeft className="size-3.5" />, actions.toggleSidebar, shortcutKeys("toggleSidebar")),
      action("inspector", "Collapse or expand files and git", <PanelRight className="size-3.5" />, actions.toggleInspector, shortcutKeys("toggleInspector")),
      action("findInFiles", "Find in files", <FileSearch className="size-3.5" />, actions.findInFiles, shortcutKeys("findInFiles")),
      action("shortcuts", "Keyboard shortcuts", <Keyboard className="size-3.5" />, actions.showShortcuts),
    );

    return result;
  }, [
    waiting,
    working,
    agentById,
    projects,
    workspaces,
    sidebar,
    activeProjectId,
    hasProject,
    actions,
    query,
    now,
    onJump,
    onClose,
    onNavigate,
  ]);

  const visible = useMemo(() => {
    const ranked = rankBy(entries, query, (entry) => entry.search);
    const searching = query.trim() !== "";
    return GROUPS.flatMap((group) =>
      ranked
        .filter((entry) => entry.group === group)
        .slice(0, searching ? 8 : RESTING_LIMIT[group]),
    );
  }, [entries, query]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const count = visible.length;
    if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      if (count) setActive((index) => (index + 1) % count);
    } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
      event.preventDefault();
      if (count) setActive((index) => (index - 1 + count) % count);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, count - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      visible[active]?.run();
    }
  }

  return (
    <div className="flex w-[min(580px,calc(100vw-24px))] flex-col overflow-hidden rounded-[var(--keel-r-window)] border border-line-strong bg-popover text-foreground shadow-[var(--keel-lift-strong)]">
      <label className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <Search className="size-4 shrink-0 text-faint" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Go to a terminal, deck, project, workspace or action"
          aria-label="Go to"
          aria-controls="island-switcher-list"
          aria-activedescendant={visible[active] ? `island-${visible[active].id}` : undefined}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-title text-foreground outline-none placeholder:text-faint"
        />
        <Keys>Esc</Keys>
      </label>

      <div
        ref={list}
        id="island-switcher-list"
        role="listbox"
        aria-label="Places and actions"
        className="max-h-[min(440px,60vh)] overflow-y-auto py-1.5"
      >
        {visible.length === 0 ? (
          <p className="px-4 py-8 text-center text-row text-faint">
            Nothing matches &ldquo;{query.trim()}&rdquo;
          </p>
        ) : (
          visible.map((entry, index) => {
            const first = index === 0 || visible[index - 1]?.group !== entry.group;
            return (
              <div key={entry.id}>
                {first ? (
                  <p className="flex items-center gap-2 px-4 pb-1 pt-2.5 text-small font-medium text-faint">
                    {entry.group}
                    {entry.group === "Waiting" ? (
                      <span className="rounded-full bg-[color:color-mix(in_srgb,var(--keel-done)_15%,transparent)] px-1.5 text-micro font-semibold leading-4 tabular-nums text-[color:var(--keel-done)]">
                        {waiting.length}
                      </span>
                    ) : null}
                  </p>
                ) : null}
                <button
                  type="button"
                  id={`island-${entry.id}`}
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  onPointerMove={() => index !== active && setActive(index)}
                  onClick={entry.run}
                  className={cn(
                    "mx-1.5 flex h-11 w-[calc(100%-12px)] items-center gap-3 rounded-[var(--keel-r-control)] px-2.5 text-left outline-none transition-colors duration-75",
                    index === active &&
                      "bg-veil-2 shadow-[inset_0_1px_0_0_var(--keel-sheen)]",
                  )}
                >
                  {entry.leading}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-row text-foreground">
                      {entry.label}
                    </span>
                    {entry.detail ? (
                      <span className="truncate text-small text-faint">
                        {entry.detail}
                      </span>
                    ) : null}
                  </span>
                  {entry.trailing ? (
                    <span className="shrink-0">{entry.trailing}</span>
                  ) : null}
                </button>
              </div>
            );
          })
        )}
      </div>

      <footer className="flex h-9 shrink-0 items-center gap-4 border-t border-line px-4 text-small text-faint">
        <span className="flex items-center gap-1.5">
          <Keys>↑</Keys>
          <Keys>↓</Keys>
          to move
        </span>
        <span className="flex items-center gap-1.5">
          <Keys>Enter</Keys>
          to go
        </span>
        {shortcutKeys("nextWaiting") ? (
          <span className="ml-auto flex items-center gap-1.5">
            <Keys>{shortcutKeys("nextWaiting")}</Keys>
            next waiting agent
          </span>
        ) : null}
      </footer>
    </div>
  );
}

function Tile({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-veil-2 text-dim shadow-[inset_0_0_0_1px_var(--keel-line)]">
      {children}
    </span>
  );
}

function Keys({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-[4px] px-1 font-sans text-micro font-medium text-faint shadow-[inset_0_0_0_1px_var(--keel-line-strong),inset_0_-1px_0_0_var(--keel-line-strong)]">
      {children}
    </kbd>
  );
}
