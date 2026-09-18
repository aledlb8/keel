import assert from "node:assert/strict";
import { it } from "node:test";
import { ChimePlayer } from "./chime.ts";

function audio() {
  const starts: number[] = [];
  const oscillators: { onended: (() => void) | null; disconnected: boolean }[] = [];
  let gainDisconnected = 0;
  let resumes = 0;
  let resume: (() => void) | undefined;
  const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
  const context = {
    state: "suspended", currentTime: 0, destination: {},
    resume() {
      resumes++;
      return new Promise<void>((resolve) => {
        resume = () => { context.state = "running"; context.currentTime = 12; resolve(); };
      });
    },
    createGain() {
      return { gain: param, connect() {}, disconnect() { gainDisconnected++; } };
    },
    createOscillator() {
      const oscillator = {
        type: "sine", frequency: param, onended: null as (() => void) | null,
        disconnected: false, connect() {},
        disconnect() { oscillator.disconnected = true; },
        start(at: number) { starts.push(at); }, stop() {},
      };
      oscillators.push(oscillator);
      return oscillator;
    },
  };
  let created = 0;
  const player = new ChimePlayer(() => { created++; return context as unknown as AudioContext; });
  return {
    player, context, starts, oscillators,
    resume: () => resume?.(),
    counts: () => ({ created, resumes, gainDisconnected }),
  };
}

it("waits for a suspended audio clock before scheduling either note", async () => {
  const a = audio();
  const playing = a.player.play();
  await Promise.resolve();
  assert.deepEqual(a.starts, []);
  a.resume();
  await playing;
  assert.deepEqual(a.starts, [12, 12.12]);
  for (const oscillator of a.oscillators) oscillator.onended?.();
  assert.equal(a.counts().gainDisconnected, 1);
  assert.ok(a.oscillators.every((oscillator) => oscillator.disconnected));
  assert.equal(a.context.state, "running");
});

it("silently unlocks on interaction and reuses that context for later alerts", async () => {
  const a = audio();
  const unlock = a.player.unlock();
  a.resume();
  await unlock;
  assert.deepEqual(a.starts, []);
  await a.player.play();
  await a.player.play();
  assert.equal(a.starts.length, 4);
  assert.deepEqual(a.counts(), { created: 1, resumes: 1, gainDisconnected: 0 });
  a.context.state = "suspended";
  const playing = a.player.play();
  assert.equal(a.starts.length, 4);
  a.resume();
  await playing;
  assert.equal(a.starts.length, 6);
});

it("tolerates missing audio and retries creating the context", async () => {
  let attempts = 0;
  const player = new ChimePlayer(() => { attempts++; throw new Error("No audio device"); });
  await player.unlock();
  await player.play();
  assert.equal(attempts, 2);
});
