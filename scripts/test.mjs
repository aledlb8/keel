#!/usr/bin/env node
// @ts-check
// Run frontend tests with an explicit file list. Node's glob is not expanded
// by pnpm on Windows, and `node --test` exits 0 when it matches nothing.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");

/**
 * @param {string} dir
 * @param {string[]} [found]
 * @returns {string[]}
 */
function collectTests(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTests(full, found);
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(full);
  }
  return found;
}

const files = collectTests(srcDir).sort();
if (files.length === 0) {
  console.error("No tests found under src/**/*.test.ts");
  process.exit(1);
}

const major = Number.parseInt(process.versions.node, 10);
const args = ["--test"];
// Node 22 needs the flag; 22.18+ and 23.6+ strip types by default.
if (major < 23) args.push("--experimental-strip-types");
args.push(...files);

const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: root });
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
