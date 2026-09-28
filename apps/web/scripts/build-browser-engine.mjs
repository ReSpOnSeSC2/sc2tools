#!/usr/bin/env node

/**
 * Build the in-browser replay engine for Instant Analysis.
 *
 * Output (generated, gitignored; see scripts/browser-engine/publish.mjs):
 *   public/pyodide/<PYODIDE_VERSION>/   self-hosted Pyodide runtime (4 files)
 *   public/engine/<ENGINE_VERSION>/<bundleId>/{engine.zip, manifest.json}
 *   public/engine/current.json          pointer to the current manifest
 *
 * Steps: check version pins (always fatal on drift) -> build hash-pinned
 * wheels in a cached venv -> assemble engine.zip inside Pyodide (wheels +
 * allowlisted repo files + unchecked-hash .pyc, deterministic) -> smoke
 * parse a fixture replay from the zip in a fresh interpreter -> publish.
 *
 * Required vs optional: the build is REQUIRED with `--require`,
 * INSTANT_ENGINE_REQUIRED=1, or NEXT_PUBLIC_INSTANT_IMPORT=admins|all (any
 * case, like the app reads it; see browser-engine/required.mjs), and
 * then any failure exits non-zero. Otherwise (the feature is off) a missing
 * Python or a failed build prints a warning and exits 0 without writing.
 *
 * Usage:
 *   npm run engine:build                     # required build
 *   node scripts/build-browser-engine.mjs    # prebuild: optional unless the flag is on
 */
import {
  assembleEngineZip,
  smokeTestEngineZip,
} from "./browser-engine/pyodideBundle.mjs";
import { readBundleFiles } from "./browser-engine/files.mjs";
import { publishBundle } from "./browser-engine/publish.mjs";
import { isEngineRequired } from "./browser-engine/required.mjs";
import { readVersions } from "./browser-engine/versions.mjs";
import { ensureWheels, findPython } from "./browser-engine/wheels.mjs";
import {
  BuildError,
  formatBytes,
  formatMs,
  logStep,
  logWarn,
} from "./browser-engine/util.mjs";

/** Summary table column widths and the wheel digest prefix shown. */
const ROLE_COLUMN = 15;
const SIZE_COLUMN = 11;
const DIGEST_PREFIX_CHARS = 16;

function timer() {
  const started = performance.now();
  return () => performance.now() - started;
}

async function buildEngine(versions, python) {
  const times = {};
  let elapsed = timer();
  const wheels = await ensureWheels(python);
  times.wheels = elapsed();
  elapsed = timer();
  const files = await readBundleFiles();
  const { zip, summary } = await assembleEngineZip({ wheels, files, schemaVersion: versions.schemaVersion });
  times.bundle = elapsed();
  logStep(`engine.zip assembled: ${summary.files} files (${summary.pyc} .pyc), ${formatBytes(zip.length)}`);
  elapsed = timer();
  const smoke = await smokeTestEngineZip(zip);
  times.smoke = elapsed();
  logStep(`smoke parse ok (${smoke.jsonBytes} B payload, Python ${smoke.pythonVersion})`);
  elapsed = timer();
  const published = await publishBundle({ versions, zip, wheels, pythonVersion: smoke.pythonVersion });
  times.publish = elapsed();
  return { ...published, wheels, times };
}

function printSummary(result, totalMs) {
  logStep(`bundle ${result.bundleId} -> ${result.pointer.manifest}`);
  for (const asset of result.manifest.assets) {
    logStep(`  ${asset.role.padEnd(ROLE_COLUMN)} ${formatBytes(asset.bytes).padStart(SIZE_COLUMN)}  ${asset.path}`);
  }
  for (const wheel of result.wheels) logStep(`  wheel ${wheel.file} sha256=${wheel.sha256.slice(0, DIGEST_PREFIX_CHARS)}…`);
  if (result.pruned.length) logStep(`  pruned stale bundles: ${result.pruned.join(", ")}`);
  const { wheels, bundle, smoke, publish } = result.times;
  logStep(`timings: wheels ${formatMs(wheels)}, bundle ${formatMs(bundle)}, smoke ${formatMs(smoke)}, `
    + `publish ${formatMs(publish)}, total ${formatMs(totalMs)}`);
}

async function main(argv, env) {
  const total = timer();
  const required = isEngineRequired(argv, env);
  const versions = await readVersions();
  const python = await findPython();
  if (!python) {
    const message = "no usable Python >= 3.10 with venv (set $PYTHON or install python3 + python3-venv)";
    if (required) throw new BuildError(message);
    logWarn(`${message}; skipping the browser engine build. Instant Analysis is unavailable in this build.`);
    return;
  }
  try {
    printSummary(await buildEngine(versions, python), total());
  } catch (error) {
    if (required) throw error;
    logWarn(`browser engine build failed; Instant Analysis is unavailable in this build.\n${error.message}`);
  }
}

main(process.argv.slice(2), process.env).then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof BuildError ? `[engine] ERROR: ${error.message}` : error);
    process.exit(1);
  },
);
