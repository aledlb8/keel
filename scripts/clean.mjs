#!/usr/bin/env node
// Remove build output. `pnpm clean` drops generated artifacts;
// `pnpm clean:all` also drops node_modules and the Rust target directory,
// which forces a full cold rebuild.

import { rmSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deep = process.argv.includes("--all");

const targets = [
  "dist",
  "release",
  "node_modules/.vite",
  "src-tauri/target/release/bundle",
  ...(deep ? ["node_modules", "src-tauri/target"] : []),
];

/** Recursive size in bytes, or 0 if the path is gone. */
function size(p) {
  if (!existsSync(p)) return 0;
  const stat = statSync(p);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    total += entry.isSymbolicLink() ? 0 : size(path.join(p, entry.name));
  }
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

let freed = 0;
for (const target of targets) {
  const full = path.join(root, target);
  if (!existsSync(full)) continue;
  const bytes = size(full);
  rmSync(full, { recursive: true, force: true });
  freed += bytes;
  console.log(`  removed ${target.padEnd(34)} ${mb(bytes)}`);
}

if (freed === 0) {
  console.log("  nothing to clean");
} else {
  console.log(`\n  freed ${mb(freed)}`);
  if (deep) console.log("  run `pnpm install` before building again");
}
