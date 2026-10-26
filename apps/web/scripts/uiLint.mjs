#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateViolations, analyzeSource, compareBaseline, HEX_ALLOWLIST, validateBaseline } from "./ui-lint/rules.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baselineFile = join(root, "scripts/ui-lint/baseline.json");
const flags = process.argv.slice(2);
if (flags.length > 1 || flags.some((flag) => !["--write-baseline", "--prune-baseline"].includes(flag))) {
  throw new Error("ui-lint: use no flags, --prune-baseline, or explicit --write-baseline");
}
const ignoredDirectories = new Set(["__tests__", "__mocks__", "tests", "fixtures", "data", ".cache", "node_modules"]);
function filesIn(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) result.push(...filesIn(file));
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)
      && !/\.(?:test|spec|generated|d)\.[cm]?[jt]sx?$/.test(entry.name)) result.push(file);
  }
  return result;
}

const files = ["app", "components", "lib"].flatMap((directory) => filesIn(join(root, directory))).sort();
const violations = files.flatMap((file) => analyzeSource(relative(root, file).replaceAll("\\", "/"), readFileSync(file, "utf8")));
const current = aggregateViolations(violations);
const write = (entries) => writeFileSync(baselineFile, JSON.stringify({ schemaVersion: 1, hexAllowlist: HEX_ALLOWLIST, entries }, null, 2) + "\n");

if (process.argv.includes("--write-baseline")) {
  write(current);
  process.stdout.write(`ui-lint: baseline explicitly written (${current.length} signatures, ${violations.length} occurrences). Review every baseline change.\n`);
} else {
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
  if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.entries)
    || JSON.stringify(baseline.hexAllowlist) !== JSON.stringify(HEX_ALLOWLIST)) throw new Error("ui-lint: invalid baseline schema or mismatched explicit hex allowlist");
  validateBaseline(baseline.entries);
  const { added, stale } = compareBaseline(current, baseline.entries);
  if (added.length) {
    process.stderr.write(`ui-lint: ${added.length} new or increased violation signature(s):\n`);
    for (const entry of added) {
      const at = violations.find((violation) => violation.file === entry.file && violation.rule === entry.rule && violation.signature === entry.signature);
      process.stderr.write(`  ${entry.file}:${at.line}:${at.column} ${entry.rule} (${entry.count} occurrence(s)) ${entry.example}\n`);
    }
    process.exitCode = 1;
  } else if (process.argv.includes("--prune-baseline")) {
    write(current);
    process.stdout.write(`ui-lint: pruned ${stale.length} retired allowance(s); no allowances added.\n`);
  } else if (stale.length) {
    process.stderr.write(`ui-lint: ${stale.length} retired allowance(s) must be removed. Run node scripts/uiLint.mjs --prune-baseline (cannot add violations).\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`ui-lint: ok (${files.length} source files, ${violations.length} existing occurrences; no new or stale allowances).\n`);
  }
}
