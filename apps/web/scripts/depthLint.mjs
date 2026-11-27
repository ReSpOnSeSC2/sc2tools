#!/usr/bin/env node
// CI depth-lint. Walks the Arcade modes folder and checks every mode
// file: a file that calls registerMode(...) or exports a `Mode`. Helper
// files beside the modes (candidate lists, fact tables) do neither and
// are skipped. Each mode file must:
//   1. declare a `depthTag` string literal,
//   2. use one of the known DEPTH_TAGS,
//   3. call registerMode(<id>, "<depthTag>") with the same tag.
//
// Run:  node apps/web/scripts/depthLint.mjs [modes-dir]
// modes-dir defaults to components/analyzer/arcade/modes; the script's
// own tests (depthLint.test.mjs) pass fixture folders. Exits non-zero on
// any violation, or when no mode file is found. web-ci runs it through
// `npm run depth-lint`, before the unit tests.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
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

// Mode files register and export at the top level, so these only match
// at the start of a line: a comment that mentions registerMode(...) (as
// modes/index.ts does) doesn't make a file a mode.
const REGISTER_CALL = /^registerMode\s*\(/m;
const REGISTER_TAG = /^registerMode\s*\(\s*[^,()]+?\s*,\s*"([^"]+)"\s*,?\s*\)/m;
const MODE_EXPORT = /^export\s+const\s+\w+\s*:\s*Mode\s*</m;
const DEPTH_TAG = /depthTag\s*:\s*"([^"]+)"/;

const here = fileURLToPath(new URL(".", import.meta.url));
const ROOT = process.argv[2]
  ? resolve(process.argv[2])
  : join(here, "..", "components", "analyzer", "arcade", "modes");

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

const files = walk(ROOT).filter((f) => basename(f) !== "index.ts");
const errors = [];
let modeFiles = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (!REGISTER_CALL.test(text) && !MODE_EXPORT.test(text)) continue;
  modeFiles += 1;

  const depthMatch = text.match(DEPTH_TAG);
  const tag = depthMatch?.[1];
  if (!depthMatch) {
    errors.push(`${rel(file)}: no depthTag literal found`);
  } else if (!KNOWN.has(tag)) {
    errors.push(`${rel(file)}: unknown depthTag "${tag}"`);
  }
  const reg = text.match(REGISTER_TAG);
  if (!reg) {
    errors.push(`${rel(file)}: no registerMode(<id>, "<depthTag>") call found`);
  } else if (depthMatch && reg[1] !== tag) {
    errors.push(
      `${rel(file)}: registerMode tag "${reg[1]}" disagrees with depthTag "${tag}"`,
    );
  }
}

if (modeFiles === 0) {
  errors.push(`${rel(ROOT) || "."}: no mode files found`);
}

function rel(p) {
  return relative(process.cwd(), p);
}

if (errors.length) {
  process.stderr.write(`depth-lint: ${errors.length} violation(s):\n`);
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}
const skipped = files.length - modeFiles;
process.stdout.write(
  `depth-lint: ok (${modeFiles} mode files scanned, ${skipped} helper files skipped)\n`,
);
