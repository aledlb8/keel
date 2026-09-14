/**
 * The island in the top bar: what it should say, and where it can take you.
 *
 * Kept free of React and of the store so the rules can be tested on their own.
 * The component asks three questions of this file:
 *
 *  - **Who is waiting?** Agents that finished and have not been looked at, the
 *    one that has waited longest first — that is the order you should go to them.
 *  - **What does the window need to say?** At most one system state, the most
 *    urgent one. Agents waiting only get the island when nothing is on fire.
 *  - **What did you mean?** A small, forgiving matcher for the switcher.
 */

import type { PaneStatus, Project } from "./types";

/** A terminal, with everything needed to name it and to go to it. */
export interface PaneRef {
  paneId: string;
  projectId: string;
  projectName: string;
  deckId: string;
  deckName: string;
  deckIndex: number;
  deckCount: number;
  agentId: string | null;
  title: string;
}

export interface WaitingPane extends PaneRef {
  /** When it finished. */
  since: number;
}

/** Every terminal in every project, in sidebar order. */
export function paneRefs(projects: Project[]): PaneRef[] {
  const refs: PaneRef[] = [];
  for (const project of projects) {
    project.decks.forEach((deck, deckIndex) => {
      for (const pane of Object.values(deck.panes)) {
        refs.push({
          paneId: pane.id,
          projectId: project.id,
          projectName: project.name,
          deckId: deck.id,
          deckName: deck.name,
          deckIndex,
          deckCount: project.decks.length,
          agentId: pane.agentId,
          title: pane.title,
        });
      }
    });
  }
  return refs;
}

/** The terminal on screen with focus: the active project's active deck's focused pane. */
export function lookingAt(
  projects: Project[],
  activeProjectId: string | null,
): string | null {
  const project = projects.find((item) => item.id === activeProjectId);
  if (!project) return null;
  const deck =
    project.decks.find((item) => item.id === project.activeDeckId) ??
    project.decks[0];
  const focused = deck?.focused ?? null;
  return focused && deck && focused in deck.panes ? focused : null;
}

/**
 * Finished agents you have not been back to, longest-waiting first. The one you
 * are looking at never counts: it is not waiting for you, you are already there.
 */
export function waitingPanes(
  projects: Project[],
  status: Record<string, PaneStatus>,
  doneAt: Record<string, number>,
  watching: string | null,
): WaitingPane[] {
  return paneRefs(projects)
    .filter((ref) => status[ref.paneId] === "done" && ref.paneId !== watching)
    .map((ref) => ({ ...ref, since: doneAt[ref.paneId] ?? 0 }))
    .sort((a, b) => a.since - b.since);
}

export function workingPanes(
  projects: Project[],
  status: Record<string, PaneStatus>,
): PaneRef[] {
  return paneRefs(projects).filter((ref) => status[ref.paneId] === "working");
}

export type SystemMoment =
  | { kind: "host-lost" }
  | { kind: "restoring"; done: number; total: number }
  | { kind: "vpn-connecting" };

/** The one system state worth the island, most urgent first; null when all is well. */
export function systemMoment(input: {
  hostLost: boolean;
  restoring: boolean;
  restoreLeft: number;
  restoreTotal: number;
  vpnConnecting: boolean;
}): SystemMoment | null {
  if (input.hostLost) return { kind: "host-lost" };
  if (input.restoring) {
    const total = Math.max(input.restoreTotal, input.restoreLeft);
    return {
      kind: "restoring",
      total,
      done: Math.max(0, total - input.restoreLeft),
    };
  }
  if (input.vpnConnecting) return { kind: "vpn-connecting" };
  return null;
}

const WORD = /[\p{L}\p{N}]/u;

/**
 * How well `query` names `text`, or null if it does not. A plain substring beats
 * letters found in order; starting a word beats landing mid-word. So "code"
 * finds "Claude Code" before "opencode", and "cc" still finds "Claude Code".
 */
export function matchScore(text: string, query: string): number | null {
  const haystack = text.toLocaleLowerCase();
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 0;

  const at = haystack.indexOf(needle);
  if (at >= 0) {
    const boundary = at === 0 || !WORD.test(haystack[at - 1]);
    return 1000 - at + (boundary ? 200 : 0) + (at === 0 ? 100 : 0);
  }

  let score = 0;
  let from = 0;
  let last = -2;
  for (const char of needle) {
    if (char === " ") continue;
    const index = haystack.indexOf(char, from);
    if (index < 0) return null;
    const boundary = index === 0 || !WORD.test(haystack[index - 1]);
    score += 1 + (boundary ? 4 : 0) + (index === last + 1 ? 3 : 0);
    last = index;
    from = index + 1;
  }
  return score;
}

/** Items matching `query` on any field, best first; ties keep their order. */
export function rankBy<T>(
  items: T[],
  query: string,
  fields: (item: T) => string[],
): T[] {
  if (!query.trim()) return items;
  return items
    .map((item, index) => {
      let score: number | null = null;
      for (const field of fields(item)) {
        const value = matchScore(field, query);
        if (value !== null && (score === null || value > score)) score = value;
      }
      return { item, index, score };
    })
    .filter(
      (entry): entry is { item: T; index: number; score: number } =>
        entry.score !== null,
    )
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

/** "just now", "4m ago", "2h ago" — how long something has been waiting. */
export function sinceLabel(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
