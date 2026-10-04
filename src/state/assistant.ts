/**
 * The main agent, from the window's side.
 *
 * Rust runs the bot and the agent (`assistant.rs`). This store mirrors its
 * state for the Telegram dialog and the footer chip, and does the two jobs only
 * the window can do:
 *
 *  - **Answer the agent's tools.** Projects, panes and terminals live here, so
 *    a tool call arrives as an event and is answered with `assistant_tool_result`.
 *  - **Report on panes.** An agent finishing, stopping to ask something, or
 *    exiting is noticed by the attention tracker here, and passed on with the
 *    end of its screen. Rust decides whether that wakes the main agent (a pane
 *    it started), goes to the phone as a notice, or goes nowhere.
 */

import { create } from "zustand";

import {
  terminalSettled,
  terminalText,
  terminalType,
} from "@/components/TerminalSurface";
import {
  assistantIpc,
  onAssistantLog,
  onAssistantSnapshot,
  onAssistantTool,
  type AssistantConfigure,
  type AssistantLogEntry,
  type AssistantSnapshot,
  type AssistantToolCall,
} from "@/lib/assistant";
import { describeWorkspace, findProject, paneChanges } from "@/lib/assistantView";
import { listPanes } from "@/lib/tree";
import type { Pane, Project } from "@/lib/types";
import { useKeel } from "@/state/store";

const LOG_LIMIT = 300;
const TAIL_LINES = 40;

interface AssistantState {
  snapshot: AssistantSnapshot | null;
  log: AssistantLogEntry[];
  dialogOpen: boolean;
  /** Panes the main agent started this session. */
  delegated: Set<string>;
  openDialog: () => void;
  closeDialog: () => void;
  setToken: (token: string) => Promise<void>;
  configure: (change: AssistantConfigure) => Promise<void>;
  pair: () => Promise<void>;
  unpair: () => Promise<void>;
  newConversation: () => Promise<void>;
  checkVoice: () => Promise<void>;
  stop: () => Promise<void>;
  send: (text: string) => Promise<void>;
}

export const useAssistant = create<AssistantState>((set) => {
  const apply = (snapshot: AssistantSnapshot) => set({ snapshot });
  return {
    snapshot: null,
    log: [],
    dialogOpen: false,
    delegated: new Set(),
    openDialog: () => set({ dialogOpen: true }),
    closeDialog: () => set({ dialogOpen: false }),
    setToken: async (token) => apply(await assistantIpc.setToken(token)),
    configure: async (change) => apply(await assistantIpc.configure(change)),
    pair: async () => apply(await assistantIpc.pair()),
    unpair: async () => apply(await assistantIpc.unpair()),
    newConversation: async () => apply(await assistantIpc.newConversation()),
    checkVoice: async () => apply(await assistantIpc.checkVoice()),
    stop: async () => {
      await assistantIpc.stop();
    },
    send: (text) => assistantIpc.send(text),
  };
});

function locate(paneId: string): { project: Project; pane: Pane } | null {
  for (const project of useKeel.getState().projects) {
    for (const deck of project.decks) {
      const pane = deck.panes[paneId];
      if (pane && listPanes(deck.tree).includes(paneId)) return { project, pane };
    }
  }
  return null;
}

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function terminalPane(paneId: string): { project: Project; pane: Pane } {
  const found = locate(paneId);
  if (!found) throw new Error(`There is no pane ${paneId}. Call list_projects for current ids.`);
  if (found.pane.editor) throw new Error(`${paneId} is an editor pane, not a terminal.`);
  return found;
}

function markDelegated(paneId: string, delegated: boolean) {
  useAssistant.setState((state) => {
    const next = new Set(state.delegated);
    if (delegated) next.add(paneId);
    else next.delete(paneId);
    return { delegated: next };
  });
  void assistantIpc.delegated(paneId, delegated).catch(() => {});
}

async function runTool(call: AssistantToolCall): Promise<string> {
  const args = call.arguments ?? {};
  const keel = useKeel.getState();
  switch (call.name) {
    case "list_projects":
      return describeWorkspace({
        agents: keel.agents,
        projects: keel.projects,
        workspaces: keel.workspaces,
        activeProjectId: keel.activeProjectId,
        status: keel.status,
        exited: keel.exited,
        delegated: useAssistant.getState().delegated,
      });

    case "read_pane": {
      const paneId = text(args, "pane_id");
      terminalPane(paneId);
      const lines = Math.min(400, Math.max(5, Number(args.lines) || 60));
      const screen = terminalText(paneId, lines);
      if (screen === null) throw new Error(`${paneId} has no terminal yet.`);
      return screen.trim() ? screen : "(the screen is empty)";
    }

    case "start_agent": {
      const project = findProject(keel.projects, text(args, "project"));
      if (!project) {
        throw new Error(
          `No project matches "${text(args, "project")}". Open projects: ${
            keel.projects.map((item) => item.name).join(", ") || "none"
          }.`,
        );
      }
      const agentId = text(args, "agent").trim() || null;
      const agent = agentId ? keel.agents.find((item) => item.id === agentId) : null;
      if (agentId && !agent) {
        throw new Error(
          `Unknown agent "${agentId}". Installed: ${keel.agents
            .filter((item) => item.installed)
            .map((item) => item.id)
            .join(", ")}.`,
        );
      }
      if (agent && !agent.installed) throw new Error(`${agent.name} isn't installed.`);
      const title = text(args, "title").trim();
      const paneId = keel.addPane(project.id, {
        agentId,
        ...(title ? { title: title.slice(0, 60) } : {}),
      });
      if (!paneId) throw new Error(`Couldn't open a pane in ${project.name}.`);
      markDelegated(paneId, true);
      const name = agent?.name ?? "a shell";
      const prompt = text(args, "prompt");
      if (!prompt.trim()) {
        return `Opened ${name} in pane ${paneId} (project ${project.name}).`;
      }
      const ready = await terminalSettled(paneId);
      await terminalType(paneId, prompt, true);
      return ready
        ? `Started ${name} in pane ${paneId} (project ${project.name}) and gave it the prompt. You'll get a [Keel] message when it finishes.`
        : `Opened ${name} in pane ${paneId} (project ${project.name}), but it was still starting after 30 seconds; the prompt was typed anyway. Check it with read_pane.`;
    }

    case "send_to_pane": {
      const paneId = text(args, "pane_id");
      terminalPane(paneId);
      const submit = args.submit !== false;
      const typed = await terminalType(paneId, text(args, "text"), submit);
      if (!typed) throw new Error(`${paneId} has no terminal yet.`);
      return submit ? `Typed into ${paneId} and pressed Enter.` : `Typed into ${paneId}.`;
    }

    case "open_project": {
      const path = text(args, "path");
      const name = text(args, "name").trim();
      const project = keel.addProject(path, name || undefined);
      return `Project "${project.name}" is open at ${project.path} (id ${project.id}).`;
    }

    case "focus_pane": {
      const paneId = text(args, "pane_id");
      if (!keel.jumpToPane(paneId)) throw new Error(`There is no pane ${paneId}.`);
      return `Showing ${paneId} in Keel.`;
    }

    case "close_pane": {
      const paneId = text(args, "pane_id");
      const found = locate(paneId);
      if (!found) throw new Error(`There is no pane ${paneId}.`);
      if (!useAssistant.getState().delegated.has(paneId)) {
        throw new Error("Only panes you started can be closed. Ask the user to close this one.");
      }
      keel.dismissPane(found.project.id, paneId);
      markDelegated(paneId, false);
      return `Closed ${paneId}.`;
    }

    default:
      throw new Error(`Keel doesn't know the tool ${call.name}.`);
  }
}

async function answer(call: AssistantToolCall) {
  try {
    await assistantIpc.toolResult(call.callId, true, await runTool(call));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await assistantIpc.toolResult(call.callId, false, message).catch(() => {});
  }
}

/** Pass pane edges to Rust. Restores replay old screens, so they are skipped. */
function watchPanes(): () => void {
  return useKeel.subscribe((state, previous) => {
    if (state.status === previous.status && state.exited === previous.exited) return;
    if (state.restoreStatus === "restoring" || !useAssistant.getState().snapshot?.owner) return;
    const delegated = useAssistant.getState().delegated;
    for (const change of paneChanges(previous, state, delegated)) {
      const found = locate(change.paneId);
      if (!found || found.pane.editor || found.pane.agentId === null) continue;
      if (change.kind !== "exited" && !found.pane.resumeAgent) continue;
      const agent =
        state.agents.find((item) => item.id === found.pane.agentId)?.name ?? found.pane.agentId;
      void assistantIpc
        .paneEvent({
          kind: change.kind,
          paneId: change.paneId,
          title: found.pane.title,
          agent,
          project: found.project.name,
          tail: terminalText(change.paneId, TAIL_LINES) ?? "",
          windowFocused: typeof document !== "undefined" && document.hasFocus(),
        })
        .catch(() => {});
    }
  });
}

/** Load state, follow Rust's events, and start answering tool calls. */
export function startAssistant(): () => void {
  let alive = true;
  const stops: Array<() => void> = [];
  const keep = (promise: Promise<() => void>) => {
    void promise.then((stop) => (alive ? stops.push(stop) : stop()));
  };

  keep(onAssistantSnapshot((snapshot) => useAssistant.setState({ snapshot })));
  keep(
    onAssistantLog((entry) =>
      useAssistant.setState((state) => ({
        log: [...state.log, entry].slice(-LOG_LIMIT),
      })),
    ),
  );
  keep(onAssistantTool((call) => void answer(call)));
  void Promise.all([assistantIpc.snapshot(), assistantIpc.log()])
    .then(([snapshot, log]) => {
      if (alive) useAssistant.setState({ snapshot, log });
    })
    .catch(() => {});
  const stopPanes = watchPanes();

  return () => {
    alive = false;
    stopPanes();
    for (const stop of stops) stop();
  };
}
