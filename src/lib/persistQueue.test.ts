import assert from "node:assert/strict";
import { it } from "node:test";
import { PersistQueue } from "./persistQueue.ts";

it("serializes old layout and newly bound conversation writes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const disk: string[] = [];
  const queue = new PersistQueue(async (value: string) => {
    if (value === "old-layout") await gate;
    disk.push(value);
  });
  const first = queue.enqueue("old-layout");
  const flush = queue.enqueue("exact-chat-id");
  await Promise.resolve();
  assert.deepEqual(disk, []);
  release();
  await Promise.all([first, flush]);
  assert.deepEqual(disk, ["old-layout", "exact-chat-id"]);
});

it("reports failed flushes and allows a subsequent save to recover", async () => {
  const disk: number[] = [];
  const queue = new PersistQueue(async (value: number) => {
    if (value === 1) throw new Error("disk full");
    disk.push(value);
  });
  const failed = queue.enqueue(1);
  const recovered = queue.enqueue(2);
  await assert.rejects(failed, /disk full/);
  await recovered;
  assert.deepEqual(disk, [2]);
});
