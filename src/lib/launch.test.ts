import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applySession,
  pickCapturedSession,
  unboundSession,
} from "./launch.ts";
import type { SessionSpec } from "./types.ts";

const grok: SessionSpec = {
  start: "--session-id {id}",
  resume: "--resume {id}",
  store: "grok",
};

const claude: SessionSpec = {
  start: "--session-id {id}",
  resume: "--resume {id}",
  store: "claude",
};

const claudeBare: SessionSpec = {
  resume: "--resume {id}",
  store: "claude",
};

const grokBare: SessionSpec = {
  resume: "--resume {id}",
  store: "grok",
};

const codex: SessionSpec = {
  resume: "resume {id}",
  kind: "subcommand",
};

const gemini: SessionSpec = {
  resume: "--resume {id}",
};

const aider: SessionSpec = {
  resume: "--restore-chat-history",
};

const leftoverId = "11111111-1111-4111-8111-111111111111";

describe("applySession", () => {
  it("launches a fresh grok without --session-id, even if a leftover id is stored", () => {
    assert.equal(
      applySession("grok", grok, {
        sessionId: leftoverId,
        sessionReady: false,
      }),
      "grok",
    );
    assert.equal(applySession("grok", grok, unboundSession()), "grok");
    assert.equal(applySession("grok", grokBare, unboundSession()), "grok");
  });

  it("reopens that grok conversation on restore once it has been captured", () => {
    assert.equal(
      applySession("grok", grok, {
        sessionId: leftoverId,
        sessionReady: true,
      }),
      "grok --resume 11111111-1111-4111-8111-111111111111",
    );
    assert.equal(
      applySession("grok", grokBare, {
        sessionId: leftoverId,
        sessionReady: true,
      }),
      "grok --resume 11111111-1111-4111-8111-111111111111",
    );
  });

  it("launches a fresh claude without --session-id or --resume", () => {
    assert.equal(
      applySession("claude", claude, {
        sessionId: leftoverId,
        sessionReady: false,
      }),
      "claude",
    );
    assert.equal(applySession("claude", claudeBare, unboundSession()), "claude");
  });

  it("resumes a captured claude conversation by id", () => {
    assert.equal(
      applySession("claude", claude, {
        sessionId: "abc-123",
        sessionReady: true,
      }),
      "claude --resume abc-123",
    );
    assert.equal(
      applySession("claude", claudeBare, {
        sessionId: "abc-123",
        sessionReady: true,
      }),
      "claude --resume abc-123",
    );
  });

  it("keeps extra flags the user put on the command", () => {
    assert.equal(
      applySession("grok --yolo", grok, {
        sessionId: leftoverId,
        sessionReady: true,
      }),
      "grok --yolo --resume 11111111-1111-4111-8111-111111111111",
    );
  });

  it("does not use --continue when a pane has no session id", () => {
    assert.equal(
      applySession("grok", grok, { sessionId: null, sessionReady: false }),
      "grok",
    );
    assert.equal(
      applySession("grok", grok, { sessionId: null, sessionReady: true }),
      "grok",
    );
  });

  it("leaves a first Codex launch alone, then resumes that id", () => {
    assert.equal(
      applySession("codex", codex, { sessionId: null, sessionReady: false }),
      "codex",
    );
    assert.equal(
      applySession("codex", codex, {
        sessionId: "abc",
        sessionReady: true,
      }),
      "codex resume abc",
    );
  });

  it("inserts a subcommand after the binary, before other args", () => {
    assert.equal(
      applySession("codex --search", codex, {
        sessionId: "abc",
        sessionReady: true,
      }),
      "codex resume abc --search",
    );
  });

  it("resumes Gemini by id, and stays a new chat without one", () => {
    assert.equal(
      applySession("gemini", gemini, { sessionId: null, sessionReady: false }),
      "gemini",
    );
    assert.equal(
      applySession("gemini", gemini, {
        sessionId: "sess",
        sessionReady: true,
      }),
      "gemini --resume sess",
    );
  });

  it("applies a resume template that does not need an id", () => {
    assert.equal(
      applySession("aider", aider, unboundSession()),
      "aider",
    );
    assert.equal(
      applySession("aider", aider, {
        sessionId: null,
        sessionReady: true,
      }),
      "aider --restore-chat-history",
    );
  });

  it("is a no-op without session metadata", () => {
    assert.equal(
      applySession("crush", undefined, {
        sessionId: null,
        sessionReady: true,
      }),
      "crush",
    );
  });
});

describe("session identity", () => {
  it("starts a new pane unbound", () => {
    assert.deepEqual(unboundSession(), {
      sessionId: null,
      sessionReady: false,
    });
  });

  it("starts a duplicate as its own fresh conversation", () => {
    const source = { sessionId: leftoverId, sessionReady: true };
    const duplicate = unboundSession();
    assert.notEqual(duplicate.sessionId, source.sessionId);
    assert.equal(duplicate.sessionReady, false);
    assert.equal(applySession("claude", claude, duplicate), "claude");
  });

  it("clears the old conversation when the account changes", () => {
    const next = unboundSession();
    assert.equal(applySession("grok", grok, next), "grok");
  });

  it("resumes a persisted pane whose conversation was captured", () => {
    const restored = { sessionId: "abc-123", sessionReady: true };
    assert.equal(
      applySession("claude", claudeBare, restored),
      "claude --resume abc-123",
    );
  });

  it("does not treat a leftover generated id as resumable", () => {
    const leftover = { sessionId: leftoverId, sessionReady: false };
    assert.equal(applySession("claude", claude, leftover), "claude");
    assert.equal(applySession("grok", grok, leftover), "grok");
  });
});

describe("pickCapturedSession", () => {
  const older = { id: "old", mtimeMs: 1_000 };
  const minted = { id: "minted", mtimeMs: 5_000 };
  const spawnedAt = 4_000;

  it("binds only the id we handed the CLI, never an older chat in the folder", () => {
    assert.equal(
      pickCapturedSession({
        mintedId: "minted",
        recent: [older, minted],
        claimed: new Set(),
        spawnedAt,
      }),
      "minted",
    );
    assert.equal(
      pickCapturedSession({
        mintedId: "minted",
        recent: [older],
        claimed: new Set(),
        spawnedAt,
      }),
      null,
    );
  });

  it("does not adopt a neighbour's recently-touched transcript", () => {
    assert.equal(
      pickCapturedSession({
        mintedId: null,
        recent: [{ id: "neighbour", mtimeMs: spawnedAt + 10 }],
        claimed: new Set(["neighbour"]),
        spawnedAt,
      }),
      null,
    );
  });

  it("without a minted id, only takes a session created at or after spawn", () => {
    assert.equal(
      pickCapturedSession({
        mintedId: null,
        recent: [older, { id: "fresh", mtimeMs: spawnedAt }],
        claimed: new Set(),
        spawnedAt,
      }),
      "fresh",
    );
    assert.equal(
      pickCapturedSession({
        mintedId: null,
        recent: [{ id: "stale", mtimeMs: spawnedAt - 1 }],
        claimed: new Set(),
        spawnedAt,
      }),
      null,
    );
  });

  it("must not wait for a leftover generated id, or the real session is never bound", () => {
    assert.equal(
      pickCapturedSession({
        mintedId: leftoverId,
        recent: [{ id: "real", mtimeMs: spawnedAt }],
        claimed: new Set(),
        spawnedAt,
      }),
      null,
    );
    assert.equal(
      pickCapturedSession({
        mintedId: null,
        recent: [{ id: "real", mtimeMs: spawnedAt }],
        claimed: new Set(),
        spawnedAt,
      }),
      "real",
    );
  });
});
