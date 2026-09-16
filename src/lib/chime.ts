/**
 * A two-note chime so a finished agent can be heard without a sound file.
 *
 * The OS toast is silent on purpose: Windows would otherwise play its own
 * alert on top of ours. No audio device, autoplay policy, or a test without
 * `AudioContext` must never throw.
 */

export function playChime(): void {
  const Ctor = typeof window === "undefined" ? undefined : window.AudioContext;
  if (!Ctor) return;
  try {
    const ctx = new Ctor();
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.exponentialRampToValueAtTime(0.1, t + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
    gain.connect(ctx.destination);

    const ping = (hz: number, start: number, stop: number) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(hz, start);
      osc.connect(gain);
      osc.start(start);
      osc.stop(stop);
    };
    ping(880, t, t + 0.16);
    ping(1318.5, t + 0.12, t + 0.34);

    const close = () => {
      void ctx.close().catch(() => {});
    };
    setTimeout(close, 400);
    void ctx.resume().catch(() => {});
  } catch {
    /* No device, autoplay blocked, or a test without audio. */
  }
}
