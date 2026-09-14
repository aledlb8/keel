#!/usr/bin/env node
// Collect the outputs of `tauri build` into a top-level `release/` directory,
// so the shippable exe and installers sit in one predictable place instead of
// scattered under src-tauri/target.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const debug = process.argv.includes("--debug");
const profile = debug ? "debug" : "release";
const targetDir = path.join(root, "src-tauri", "target", profile);
const outDir = path.join(root, "release");

if (!existsSync(targetDir)) {
  console.error(`No build output at ${path.relative(root, targetDir)} — run \`pnpm build:app\` first.`);
  process.exit(1);
}

// Extensions worth shipping. The plain binary lives at the profile root;
// installers land in bundle/<format>/.
const SHIPPABLE = new Set([".exe", ".msi", ".dmg", ".app", ".deb", ".rpm", ".AppImage", ".sig"]);

/** Walk a directory tree collecting shippable files, skipping Cargo's intermediates. */
function collect(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["deps", "build", "incremental", ".fingerprint", "examples"].includes(entry.name)) continue;
      collect(full, found);
    } else if (SHIPPABLE.has(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

const bundleDir = path.join(targetDir, "bundle");
const binaries = readdirSync(targetDir, { withFileTypes: true })
  .filter((e) => e.isFile() && SHIPPABLE.has(path.extname(e.name)))
  .map((e) => path.join(targetDir, e.name));
const bundles = existsSync(bundleDir) ? collect(bundleDir) : [];
const artifacts = [...binaries, ...bundles];

if (artifacts.length === 0) {
  console.error(`No artifacts found under ${path.relative(root, targetDir)}.`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(`\nArtifacts → ${path.relative(root, outDir)}/\n`);

for (const src of artifacts) {
  const dest = path.join(outDir, path.basename(src));
  copyFileSync(src, dest);
  console.log(`  ${path.basename(src).padEnd(40)} ${mb(statSync(dest).size)}`);
}
console.log();
