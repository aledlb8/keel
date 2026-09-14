import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applySession, sessionNeedsId } from "./launch.ts";
import type { SessionSpec } from "./types.ts";

const grok: SessionSpec = {
  start: "--session-id {id}",
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

describe("applySession", () => {
  it("types a fresh grok with the pane's session id", () => {
    assert.equal(
      applySession("grok", grok, {
        sessionId: "11111111-1111-4111-8111-111111111111",
        sessionReady: false,
      }),
      "grok --session-id 11111111-1111-4111-8111-111111111111",
    );
  });

  it("reopens that grok conversation on the next spawn", () => {
    assert.equal(
      applySession("grok", grok, {
        sessionId: "11111111-1111-4111-8111-111111111111",
        sessionReady: true,
      }),
      "grok --resume 11111111-1111-4111-8111-111111111111",
    );
  });

  it("keeps extra flags the user put on the command", () => {
    assert.equal(
      applySession("grok --yolo", grok, {
        sessionId: "11111111-1111-4111-8111-111111111111",
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

describe("sessionNeedsId", () => {
  it("is true only when first launch can pick the id", () => {
    assert.equal(sessionNeedsId(grok), true);
    assert.equal(sessionNeedsId(codex), false);
    assert.equal(sessionNeedsId(gemini), false);
    assert.equal(sessionNeedsId(undefined), false);
  });
});
