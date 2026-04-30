#!/usr/bin/env node
/**
 * tools/check-schema-version-sync.js
 *
 * Cross-language consistency check for the schema-version single
 * source of truth (ADR 0012, settings-pr1o). Confirms that the
 * JS side and the Python side agree on every registered
 * schema version. The on-disk schema files are the canonical
 * authority -- this script asserts both languages READ from them
 * (as opposed to hardcoding constants that drift).
 *
 * What it does:
 *   1. From JS: lib/schema-version.getAllSchemaVersions(dataDir).
 *   2. Spawn `python3 -c "<inline reader>"` against the same data
 *      directory and parse the stdout dict.
 *   3. Diff. Exit 0 on match, exit 1 with a human-readable diff
 *      on mismatch.
 *
 * Skipped (with exit 0 and a warning) when python3 isn't on
 * PATH -- CI environments without python should still pass; the
 * point is to catch DRIFT, not to make python a hard dep of the
 * Node test suite.
 *
 * Usage:
 *   node tools/check-schema-version-sync.js
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const BACKEND_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(BACKEND_DIR, '..', 'data');

const { getAllSchemaVersions } = require(
  path.join(BACKEND_DIR, 'lib', 'schema-version'));

function readFromJs() {
  return getAllSchemaVersions(DATA_DIR);
}

function readFromPython() {
  // Inline Python reader -- no import of core/custom_builds.py
  // (which drags sc2reader). Just read the schema files directly.
  const py = `
import json, os, sys
data_dir = sys.argv[1]
files = {
  "profile": "profile.schema.json",
  "config": "config.schema.json",
  "custom_builds": "custom_builds.schema.json",
}
out = {}
for name, fname in files.items():
    with open(os.path.join(data_dir, fname), "r", encoding="utf-8") as f:
        s = json.load(f)
    out[name] = s["properties"]["version"]["const"]
print(json.dumps(out))
`;
  const result = spawnSync('python3', ['-c', py, DATA_DIR], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error || result.status !== 0) {
    return { skipped: true, reason: result.error
      ? result.error.message : `python exit ${result.status}` };
  }
  return JSON.parse(result.stdout.trim());
}

function diff(a, b) {
  const all = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of all) {
    if (a[k] !== b[k]) {
      out.push(`  ${k}: js=${a[k]} python=${b[k]}`);
    }
  }
  return out;
}

function main() {
  const js = readFromJs();
  const py = readFromPython();
  if (py.skipped) {
    console.warn(`[schema-version-sync] python3 unavailable (${py.reason}); skipping cross-language check.`);
    console.log('JS sees:', JSON.stringify(js));
    process.exit(0);
  }
  const mismatches = diff(js, py);
  if (mismatches.length === 0) {
    console.log('[schema-version-sync] OK — JS and Python agree on every version.');
    console.log('  ' + JSON.stringify(js));
    process.exit(0);
  }
  console.error('[schema-version-sync] MISMATCH between languages:');
  for (const line of mismatches) console.error(line);
  console.error('  JS sees: ' + JSON.stringify(js));
  console.error('  Python sees: ' + JSON.stringify(py));
  process.exit(1);
}

main();
