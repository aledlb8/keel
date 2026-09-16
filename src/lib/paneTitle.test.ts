import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  briefFromOsc,
  briefFromPrompt,
  createPromptDraft,
  isGenericLabel,
  sanitizeTitle,
  TITLE_MAX,
  type TitleAgent,
} from "./paneTitle.ts";

const claude: TitleAgent = {
  name: "Claude",
  short: "CL",
  command: "claude",
};

describe("briefFromPrompt", () => {
  it("keeps a real request", () => {
    assert.equal(
      briefFromPrompt("  fix the login redirect  "),
      "fix the login redirect",
    );
  });

  it("rejects confirmations, slash commands and short lines", () => {
    assert.equal(briefFromPrompt("yes"), null);
    assert.equal(briefFromPrompt("y"), null);
    assert.equal(briefFromPrompt("/help"), null);
    assert.equal(briefFromPrompt("/clear"), null);
    assert.equal(briefFromPrompt("hi"), null);
    assert.equal(briefFromPrompt("   "), null);
  });

  it("takes the topic out of /title", () => {
    assert.equal(briefFromPrompt("/title fix auth"), "fix auth");
  });

  it("clips on a word boundary", () => {
    const words = Array.from({ length: 20 }, () => "something").join(" ");
    const brief = briefFromPrompt(words);
    assert.ok(brief);
    assert.ok(brief.length <= TITLE_MAX);
    assert.equal(brief.includes(" "), true);
    assert.equal(brief.endsWith("something") || brief.endsWith("somet"), true);
  });
});

describe("briefFromOsc", () => {
  it("drops the program name and a version", () => {
    assert.equal(briefFromOsc("Claude Code", claude), null);
    assert.equal(briefFromOsc("claude", claude), null);
    assert.equal(briefFromOsc("CL", claude), null);
    assert.equal(briefFromOsc("2.1.119", claude), null);
  });

  it("keeps a topic after the program name", () => {
    assert.equal(
      briefFromOsc("Claude Code — fix the login redirect", claude),
      "fix the login redirect",
    );
    assert.equal(
      briefFromOsc("* add unit tests for the store", claude),
      "add unit tests for the store",
    );
  });

  it("drops paths and console titles", () => {
    assert.equal(briefFromOsc("C:\\Users\\developer\\code\\keel", claude), null);
    assert.equal(briefFromOsc("~/Documents/code/keel", claude), null);
    assert.equal(briefFromOsc("powershell.exe", claude), null);
    assert.equal(briefFromOsc("Administrator: C:\\Windows", claude), null);
  });

  it("strips controls and refuses Keel impersonation", () => {
    assert.equal(briefFromOsc("Keel", claude), null);
    assert.equal(briefFromOsc("Keel\nYour files are gone", claude), null);
    assert.equal(
      briefFromOsc("Keel — fix the login redirect", claude),
      "fix the login redirect",
    );
    assert.equal(
      briefFromOsc("fix the\x07 login\nredirect", claude),
      "fix the login redirect",
    );
  });
});

describe("sanitizeTitle", () => {
  it("turns C0/C1 into spaces and trims", () => {
    assert.equal(sanitizeTitle("fix\nthe\x1btask\x9B"), "fix the task");
    assert.equal(sanitizeTitle("\x00Keel\r\n"), "Keel");
  });
});

describe("isGenericLabel", () => {
  it("treats the factory name as generic", () => {
    assert.equal(isGenericLabel("Claude", claude), true);
    assert.equal(isGenericLabel("Shell", null), true);
    assert.equal(isGenericLabel("fix the login redirect", claude), false);
  });
});

describe("createPromptDraft", () => {
  it("commits a typed line on enter", () => {
    const draft = createPromptDraft();
    for (const char of "fix the tests") draft.push(char);
    assert.equal(draft.push("\r"), "fix the tests");
  });

  it("handles backspace and ctrl-c", () => {
    const draft = createPromptDraft();
    for (const char of "hello world") draft.push(char);
    draft.push("\x7f");
    draft.push("\x7f");
    assert.equal(draft.push("\r"), "hello wor");
    for (const char of "this will vanish") draft.push(char);
    draft.push("\x03");
    assert.equal(draft.push("\r"), null);
  });

  it("ignores arrow keys", () => {
    const draft = createPromptDraft();
    for (const char of "fix auth") draft.push(char);
    assert.equal(draft.push("\x1b[A"), null);
    assert.equal(draft.push("\r"), "fix auth");
  });

  it("commits a paste that includes a newline", () => {
    const draft = createPromptDraft();
    assert.equal(
      draft.push("rewrite the overview schematic\n"),
      "rewrite the overview schematic",
    );
  });
});
