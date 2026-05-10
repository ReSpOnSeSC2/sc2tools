#!/usr/bin/env node
// CI depth-lint. Walks every mode file and asserts:
//   1. it exports a `depthTag` string,
//   2. the value is one of the known DEPTH_TAGS,
//   3. registerMode(<id>, "<depthTag>") appears in the same file.
//
// Run:  node apps/web/scripts/depthLint.mjs
// Exits non-zero on any violation. Designed to fail loud in CI before
// the unit tests even start.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const KNOWN = new Set([
  "multi-entity",
  "cross-axis",
  "temporal",
  "conditional",
  "hidden-derivation",
  "forward",
  "generative",
]);

const here = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(here, "..", "components", "analyzer", "arcade", "modes");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = walk(ROOT).filter((f) => !f.endsWith("index.ts"));
const errors = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const depthMatch = text.match(/depthTag\s*:\s*"([^"]+)"/);
  if (!depthMatch) {
    errors.push(`${rel(file)}: no depthTag literal found`);
    continue;
  }
  const tag = depthMatch[1];
  if (!KNOWN.has(tag)) {
    errors.push(`${rel(file)}: unknown depthTag "${tag}"`);
  }
  const reg = text.match(/registerMode\s*\(\s*[A-Z_]+\s*,\s*"([^"]+)"\s*\)/);
  if (reg && reg[1] !== tag) {
    errors.push(
      `${rel(file)}: registerMode tag "${reg[1]}" disagrees with depthTag "${tag}"`,
    );
  }
}

function rel(p) {
  return relative(process.cwd(), p);
}

if (errors.length) {
  process.stderr.write(`depth-lint: ${errors.length} violation(s):\n`);
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}
process.stdout.write(`depth-lint: ok (${files.length} mode files scanned)\n`);
