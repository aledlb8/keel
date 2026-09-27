import { AgentActivity, type AgentSignal } from "./agentActivity.ts";
import { hasAgentHooks, type AgentEvent } from "./agentEvents.ts";
import { isSessionId } from "./launch.ts";
import type { PaneStatus } from "./types.ts";

type Phase = "idle" | "working" | "waiting" | "completed" | "cancelled" | "failed" | "ended";

/** One shell generation. Process, conversation and turn lifetimes are distinct.
 * All hook validation happens here, before the store changes durable identity.
 * Screen inference is isolated in AgentActivity and never owns a conversation.
 */
export class AgentRuntime {
  private screenActivity = new AgentActivity();
  private sequence = 0;
  private processId: string | undefined;
  private retiredProcesses = new Set<string>();
  private agentId: string | undefined;
  private sessionId: string | undefined;
  private turnId: string | undefined;
  private retiredTurns = new Set<string>();
  private phase: Phase = "idle";
  private protocol = false;
  private completion = false;
  private interrupted = false;
  private revision = 0;

  get usesProtocol(): boolean { return this.protocol; }
  get needsScreen(): boolean { return !this.protocol || this.interrupted; }
  get processRevision(): number { return this.revision; }
  get hasOwner(): boolean { return this.agentId !== undefined; }

  /** False means a delayed process observation, not a new owner. */
  observeProcess(agentId: string, processId?: string): boolean {
    if (processId && this.retiredProcesses.has(processId)) return false;
    if (this.agentId === agentId && (!processId || this.processId === processId)) return true;
    // A watcher may identify a process after its first hook. Missing process
    // identity is not evidence of a replacement.
    if (this.agentId === agentId && !this.processId) {
      this.processId = processId;
      return true;
    }
    this.resetProcess();
    this.processId = processId;
    this.agentId = agentId;
    return true;
  }

  endProcess(processId?: string): boolean {
    if (this.processId && this.processId !== processId) return false;
    if (processId && this.retiredProcesses.has(processId)) return false;
    this.resetProcess();
    return true;
  }

  private resetProcess(): void {
    this.revision++;
    if (this.processId) this.retiredProcesses.add(this.processId);
    this.processId = undefined;
    this.agentId = undefined;
    this.sessionId = undefined;
    this.turnId = undefined;
    this.retiredTurns.clear();
    this.phase = "idle";
    this.protocol = false;
    this.completion = false;
    this.interrupted = false;
    this.screenActivity = new AgentActivity();
    // Sequence belongs to the shell channel and survives CLI exits.
  }

  event(event: AgentEvent): boolean {
    if (!hasAgentHooks(event.agentId) || !isSessionId(event.sessionId) ||
        !Number.isSafeInteger(event.sequence) || event.sequence <= this.sequence ||
        event.kind === "connected" || event.kind === "unavailable") return false;
    this.sequence = event.sequence;
    const establishesIdentity = event.kind === "session" || event.kind === "working";
    if (this.agentId && this.agentId !== event.agentId && !establishesIdentity) return false;
    if (event.processId && this.retiredProcesses.has(event.processId)) return false;
    const replacement = this.agentId !== event.agentId ||
      (event.processId && this.processId && event.processId !== this.processId);
    if (!replacement && this.sessionId && this.sessionId !== event.sessionId && !establishesIdentity) return false;
    if (!this.observeProcess(event.agentId, event.processId)) return false;
    if (this.sessionId !== event.sessionId) {
      this.phase = "idle";
      this.completion = false;
      this.interrupted = false;
      this.turnId = undefined;
      this.retiredTurns.clear();
      this.sessionId = event.sessionId;
    }
    const turnId = event.turnId;
    if (turnId && this.retiredTurns.has(turnId)) return false;
    if (turnId && this.turnId && turnId !== this.turnId) {
      if (event.kind !== "working") return false;
      this.retiredTurns.add(this.turnId);
      this.phase = "idle";
    }
    if (turnId) this.turnId = turnId;
    this.protocol = true;
    switch (event.kind) {
      case "session": case "identity": case "idle":
        // Identity refresh and compaction are not turn boundaries.
        break;
      case "working":
        this.phase = "working";
        this.interrupted = false;
        this.completion = false;
        break;
      case "progress": case "waiting":
        // Late tool teardown cannot resurrect a failed/cancelled turn.
        if (this.phase === "cancelled" || this.phase === "failed" || this.phase === "ended") break;
        this.phase = event.kind === "waiting" ? "waiting" : "working";
        this.completion = false;
        break;
      case "completed":
        if (this.phase === "working" || this.phase === "waiting") {
          this.completion = !this.interrupted;
          this.phase = this.interrupted ? "cancelled" : "completed";
        }
        break;
      case "cancelled": case "failed": case "ended":
        this.phase = event.kind;
        this.completion = false;
        break;
    }
    return true;
  }

  acknowledge(): void { this.completion = false; }

  input(data: string, now: number): "submit" | "input" | "report" {
    const signal = this.screenActivity.input(data, now);
    if (signal !== "report") this.acknowledge();
    if (this.protocol && (this.phase === "working" || this.phase === "waiting") && signal === "interrupt") {
      this.interrupted = true;
      this.screenActivity.interrupt();
    }
    return signal === "interrupt" ? "input" : signal;
  }

  output(now: number): void { if (this.needsScreen) this.screenActivity.output(now); }
  screen(signal: AgentSignal, now: number, fingerprint?: string): void {
    if (this.needsScreen) this.screenActivity.screen(signal, now, fingerprint);
  }
  resize(): void { this.screenActivity.resize(); }

  status(previous: PaneStatus, now: number, watching: boolean): PaneStatus {
    if (!this.protocol) return this.screenActivity.status(previous, now, watching);
    // Claude does not fire Stop on user interruption. A local interrupt may
    // settle to cancelled from a live prompt, but can never announce success.
    if (this.interrupted && this.screenActivity.status("working", now, true) === "idle") {
      this.phase = "cancelled";
      this.interrupted = false;
    }
    if (this.phase === "working" || this.phase === "waiting") return this.phase;
    if (this.completion) {
      this.completion = false;
      return watching ? "idle" : "done";
    }
    return previous === "done" ? "done" : "idle";
  }
}
