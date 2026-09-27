#!/usr/bin/env node
// Real Claude hook loader -> production Keel executable -> loopback HTTP.
// Uses an isolated configuration and --init-only: no model request or user hooks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "src-tauri/target/debug", process.platform === "win32" ? "keel.exe" : "keel");
await access(executable); // Run cargo build --manifest-path src-tauri/Cargo.toml first.
const directory = await mkdtemp(path.join(tmpdir(), "keel-cli-smoke-"));
const token = randomUUID();
const events = [];
const server = http.createServer(async (request, response) => {
  if (request.url !== `/${token}/claude` || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    events.push(JSON.parse(body));
    response.setHeader("Content-Type", "application/json");
    response.end("{}");
  } catch {
    response.writeHead(400).end();
  }
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const script = `& '${executable.replaceAll("'", "''")}' --keel-agent-hook claude`;
  const command = process.platform === "win32"
    ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`
    : `'${executable.replaceAll("'", "'\\''")}' --keel-agent-hook claude`;
  const settings = path.join(directory, "settings.json");
  await writeFile(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
    type: "command", command, timeout: 3, statusMessage: "Keel activity",
  }] }] } }));
  const child = spawn(process.env.KEEL_SMOKE_CLAUDE || "claude", [
    "--init-only", "--setting-sources", "", "--settings", settings, "--strict-mcp-config",
  ], {
    cwd: directory,
    windowsHide: true,
    env: {
      ...process.env, CLAUDE_CONFIG_DIR: directory,
      ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "",
      KEEL_HOOK_PORT: String(server.address().port), KEEL_HOOK_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (data) => { output = (output + data).slice(-4000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const timeout = setTimeout(() => child.kill(), 20_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(code, 0, `Claude startup failed: ${output}`);
  assert.equal(events.length, 1, "Expected exactly one startup event from the real hook loader");
  assert.equal(events[0].hook_event_name, "SessionStart");
  assert.match(events[0].session_id, /^[A-Za-z0-9._-]{1,128}$/);
  assert.ok(Number.isInteger(events[0].sender_pid) && events[0].sender_pid > 0);
  console.log("PASS: installed Claude -> production Keel helper -> SessionStart with conversation identity");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
