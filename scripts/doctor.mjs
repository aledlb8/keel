#!/usr/bin/env node
// Preflight check: is this machine able to build Keel end to end?
// Run with `pnpm doctor`. Exits non-zero if anything required is missing.

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Run a command and return trimmed stdout, or null if it is not runnable.
 * `shell` defaults on for Windows, where pnpm and cargo are .cmd shims that
 * cannot be exec'd directly. Every argument here is a fixed literal, so the
 * string form is safe; it must be off for arguments cmd.exe would rewrite.
 */
function probe(cmd, args, { shell = process.platform === "win32" } = {}) {
  try {
    const out = shell
      ? execSync([cmd, ...args].join(" "), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      : execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() === "" ? null : out.trim();
  } catch {
    return null;
  }
}

const results = [];

/** @param {{name: string, required?: boolean, value: string|null, hint: string}} check */
function report({ name, required = true, value, hint }) {
  const ok = value !== null;
  results.push({ name, required, ok });
  const mark = ok ? `${GREEN}ok${RESET}` : required ? `${RED}missing${RESET}` : `${YELLOW}skipped${RESET}`;
  const detail = ok ? `${DIM}${value.split("\n")[0]}${RESET}` : `${DIM}${hint}${RESET}`;
  console.log(`  ${name.padEnd(22)} ${mark.padEnd(20)} ${detail}`);
}

console.log("\nKeel build environment\n");

const node = process.versions.node;
report({
  name: "node",
  value: Number(node.split(".")[0]) >= 20 ? `v${node}` : null,
  hint: `v${node} found, need >= 20`,
});

const pnpm = probe("pnpm", ["--version"]);
report({
  name: "pnpm",
  value: pnpm && Number(pnpm.split(".")[0]) >= 11 ? pnpm : null,
  hint: pnpm ? `${pnpm} found, need >= 11 — run: corepack enable` : "run: corepack enable",
});

report({
  name: "dependencies",
  value: existsSync(path.join(root, "node_modules", ".bin")) ? "node_modules present" : null,
  hint: "run: pnpm install",
});

report({
  name: "rustc",
  value: probe("rustc", ["--version"]),
  hint: "install from https://rustup.rs",
});

report({
  name: "cargo",
  value: probe("cargo", ["--version"]),
  hint: "install from https://rustup.rs",
});

report({
  name: "rustfmt",
  required: false,
  value: probe("cargo", ["fmt", "--version"]),
  hint: "run: rustup component add rustfmt",
});

report({
  name: "clippy",
  required: false,
  value: probe("cargo", ["clippy", "--version"]),
  hint: "run: rustup component add clippy",
});

if (process.platform === "win32") {
  // Tauri renders through the system WebView2 runtime rather than bundling one.
  // The runtime registers itself under one of three keys depending on whether it
  // was installed per-machine, per-machine on 64-bit, or per-user.
  const CLIENT = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
  const query = ["HKLM:/SOFTWARE/WOW6432Node", "HKLM:/SOFTWARE", "HKCU:/SOFTWARE"]
    .map((hive) => `(Get-ItemProperty '${hive}/Microsoft/EdgeUpdate/Clients/${CLIENT}' -EA SilentlyContinue).pv`)
    .join("; ");
  const version = probe("powershell", ["-NoProfile", "-Command", query], { shell: false });
  report({
    name: "WebView2 runtime",
    value: version ? version.split("\n")[0].trim() : null,
    hint: "install from https://developer.microsoft.com/microsoft-edge/webview2/",
  });

  // The MSVC linker is what actually fails a build; the host triple is the
  // cheapest reliable signal that rustup installed the right toolchain.
  const host = probe("rustc", ["-vV"]);
  report({
    name: "MSVC toolchain",
    value: host?.includes("msvc") ? host.split("\n").find((l) => l.startsWith("host:")) : null,
    hint: "install Visual Studio Build Tools with the C++ workload",
  });
} else if (process.platform === "linux") {
  report({
    name: "webkit2gtk",
    value: probe("pkg-config", ["--modversion", "webkit2gtk-4.1"]),
    hint: "install libwebkit2gtk-4.1-dev (see https://tauri.app/start/prerequisites/)",
  });
}

const missing = results.filter((r) => r.required && !r.ok);
const optional = results.filter((r) => !r.required && !r.ok);

console.log();
if (missing.length > 0) {
  console.log(`${RED}Cannot build:${RESET} ${missing.map((r) => r.name).join(", ")} — see hints above.\n`);
  process.exit(1);
}
if (optional.length > 0) {
  console.log(`${YELLOW}Ready to build.${RESET} Optional tooling absent: ${optional.map((r) => r.name).join(", ")}\n`);
} else {
  console.log(`${GREEN}Ready to build.${RESET} Run \`pnpm build:app\` for installers, or \`pnpm build\` for just the binary.\n`);
}
