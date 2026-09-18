/** Reuse audio unlocked by a user gesture, including for background alerts. */
export class ChimePlayer {
  private context: AudioContext | undefined;
  private readonly createContext: () => AudioContext;

  constructor(createContext: () => AudioContext) {
    this.createContext = createContext;
  }

  private async ready(): Promise<AudioContext> {
    if (!this.context || this.context.state === "closed") this.context = this.createContext();
    const ctx = this.context;
    if (ctx.state !== "running") await ctx.resume();
    return ctx;
  }

  async unlock(): Promise<void> {
    try {
      await this.ready();
    } catch {
      // A later gesture can retry if no device is currently available.
    }
  }

  async play(): Promise<void> {
    try {
      const ctx = await this.ready();
      if (ctx.state !== "running") return;
      // Schedule only after resume. A wall-clock timeout must not close a
      // suspended context before its audio clock has even started.
      const t = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(0.1, t + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
      gain.connect(ctx.destination);

      let remaining = 2;
      const ping = (hz: number, start: number, stop: number) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(hz, start);
        osc.connect(gain);
        osc.onended = () => {
          osc.disconnect();
          if (--remaining === 0) gain.disconnect();
        };
        osc.start(start);
        osc.stop(stop);
      };
      ping(880, t, t + 0.16);
      ping(1318.5, t + 0.12, t + 0.34);
    } catch {
      // Audio failure must never interrupt activity tracking or OS toasts.
    }
  }
}

const player = new ChimePlayer(() => new window.AudioContext());

/** Install at startup so the first background completion can already play. */
export function startChimeAudio(): () => void {
  const unlock = () => { void player.unlock(); };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
  return () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
}

export function playChime(): void {
  void player.play();
}
