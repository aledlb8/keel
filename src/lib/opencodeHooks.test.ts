import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";
import { readFile } from "node:fs/promises";

// Exercise the exact JS embedded in the Rust binary, with no bundler transform.
const source = await readFile(new URL("../../src-tauri/src/opencode_hooks.mjs", import.meta.url), "utf8");
const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const makePlugin = module.default.server as (context: unknown) => Promise<{
  event?: (payload: { event: unknown }) => Promise<void>;
}>;
const posted: { session_id: string; hook_event_name: string }[] = [];
const originalPort = process.env.KEEL_HOOK_PORT;
const originalToken = process.env.KEEL_HOOK_TOKEN;

beforeEach(() => {
  posted.length = 0;
  process.env.KEEL_HOOK_PORT = "12345";
  process.env.KEEL_HOOK_TOKEN = "test-capability";
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.sender_pid, process.pid);
    posted.push({ session_id: body.session_id, hook_event_name: body.hook_event_name });
    return new Response("{}");
  });
});
afterEach(() => {
  if (originalPort === undefined) delete process.env.KEEL_HOOK_PORT;
  else process.env.KEEL_HOOK_PORT = originalPort;
  if (originalToken === undefined) delete process.env.KEEL_HOOK_TOKEN;
  else process.env.KEEL_HOOK_TOKEN = originalToken;
  mock.restoreAll();
});

it("supports the current OpenCode loader and stays inert outside Keel", async () => {
  assert.equal(module.default.id, "keel-status");
  assert.equal(module.KeelStatus, makePlugin);
  delete process.env.KEEL_HOOK_TOKEN;
  assert.deepEqual(await makePlugin({ client: {} }), {});
});

it("keeps root lifecycle order across SDK waits and ignores child completion", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const plugin = await makePlugin({ client: { session: { get: async ({ path }: { path: { id: string } }) => {
    await gate;
    return { data: { id: path.id, ...(path.id === "child" ? { parentID: "root" } : {}) } };
  } } } });
  const busy = plugin.event!({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } } });
  const idle = plugin.event!({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } } });
  assert.equal(posted.length, 0);
  release();
  await Promise.all([busy, idle]);
  await plugin.event!({ event: { type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } } });
  assert.deepEqual(posted, [
    { session_id: "root", hook_event_name: "UserPromptSubmit" },
    { session_id: "root", hook_event_name: "Stop" },
  ]);
});

it("captures a new root immediately and does no work for token deltas", async () => {
  const plugin = await makePlugin({ client: {} });
  await plugin.event!({ event: { type: "session.created", properties: { info: { id: "fresh" } } } });
  for (let n = 0; n < 1000; n++) {
    await plugin.event!({ event: { type: "message.part.updated", properties: {} } });
  }
  assert.deepEqual(posted, [{ session_id: "fresh", hook_event_name: "SessionStart" }]);
});

it("ignores unknown statuses and preserves retry/permission replies as progress", async () => {
  const plugin = await makePlugin({ client: { session: { get: async () => ({ data: { id: "root" } }) } } });
  for (const type of [undefined, "future-status", "retry"]) {
    await plugin.event!({ event: { type: "session.status", properties: { sessionID: "root", status: { type } } } });
  }
  await plugin.event!({ event: { type: "permission.replied", properties: { sessionID: "root" } } });
  assert.deepEqual(posted, [
    { session_id: "root", hook_event_name: "PostToolUse" },
    { session_id: "root", hook_event_name: "PostToolUse" },
  ]);
});
