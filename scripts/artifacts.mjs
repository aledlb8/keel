#!/usr/bin/env node
// @ts-check
// Collect the outputs of `tauri build` into a top-level `release/` directory,
// so the shippable exe and installers sit in one predictable place instead of
// scattered under src-tauri/target.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const debug = process.argv.includes("--debug");
const binaryOnly = process.argv.includes("--binary-only");
const profile = debug ? "debug" : "release";
const targetDir = path.join(root, "src-tauri", "target", profile);
const outDir = path.join(root, "release");
const tauriConfig = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const mainBinaryName = tauriConfig.mainBinaryName ?? tauriConfig.productName ?? "keel";

if (!existsSync(targetDir)) {
  console.error(`No build output at ${path.relative(root, targetDir)} — run a Keel build first.`);
  process.exit(1);
}

// Extensions worth shipping. The plain binary lives at the profile root;
// installers land in bundle/<format>/.
const SHIPPABLE = new Set([".exe", ".msi", ".dmg", ".deb", ".rpm", ".AppImage", ".sig"]);

/**
 * Walk a bundle tree collecting shippable files/directories.
 * @param {string} dir
 * @param {string[]} [found]
 * @returns {string[]}
 */
function collect(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path.extname(entry.name) === ".app") {
        found.push(full);
        continue;
      }
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
  .filter(
    (e) =>
      e.isFile() &&
      (SHIPPABLE.has(path.extname(e.name)) || e.name === mainBinaryName || e.name === `${mainBinaryName}.exe`),
  )
  .map((e) => path.join(targetDir, e.name));
const bundles = !binaryOnly && existsSync(bundleDir) ? collect(bundleDir) : [];
const artifacts = [...binaries, ...bundles];

if (artifacts.length === 0) {
  console.error(`No artifacts found under ${path.relative(root, targetDir)}.`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/**
 * Destination in `outDir` for `src`. Same basenames from different folders
 * get a parent-directory prefix, then a counter if still colliding.
 * @param {string} src
 * @param {Set<string>} used
 * @returns {string}
 */
function uniqueDest(src, used) {
  const base = path.basename(src);
  const parent = path.basename(path.dirname(src));
  const names = [base, `${parent}-${base}`];
  for (let i = 0; ; i++) {
    const name = names[i] ?? `${parent}-${i}-${base}`;
    const dest = path.join(outDir, name);
    if (!used.has(dest) && !existsSync(dest)) {
      used.add(dest);
      return dest;
    }
  }
}

const mb = (/** @type {number} */ bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(`\nArtifacts → ${path.relative(root, outDir)}/\n`);

/** @type {Set<string>} */
const used = new Set();
for (const src of artifacts) {
  const dest = uniqueDest(src, used);
  const label = path.basename(dest);
  if (statSync(src).isDirectory()) {
    cpSync(src, dest, { recursive: true });
    console.log(`  ${label.padEnd(40)} directory`);
  } else {
    copyFileSync(src, dest);
    console.log(`  ${label.padEnd(40)} ${mb(statSync(dest).size)}`);
  }
}
console.log();
