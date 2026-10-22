#!/usr/bin/env node
"use strict";

/**
 * Re-fetch the ladder map pool from Liquipedia and update the committed
 * cold-start seed (data/ladder-map-pool.json) when the pool changed.
 *
 * Production doesn't depend on this: the API refreshes its pool on boot
 * and every 24 h (src/jobs/ladderMapPoolRefreshJob.js). The seed is
 * only what a fresh container serves when Liquipedia is unreachable at
 * boot. .github/workflows/ladder-map-pool.yml runs this weekly and opens
 * a PR when the seed changes, so that PR doubles as the rotation notice.
 *
 * The seed is rewritten only when the 1v1 or team map list changed
 * (order-insensitive); a refresh that only moves ``fetchedAt`` leaves
 * the file untouched so git stays quiet between rotations.
 *
 * Exit codes
 * ----------
 *   0  pool fetched; seed rewritten if the map lists changed
 *   1  Liquipedia unreachable, or the page parsed to no 1v1 maps — if
 *      the page loads in a browser, Liquipedia changed its template and
 *      parseLadderMaps (src/services/ladderMapPool.js) needs updating
 *
 * Usage
 * -----
 *   node apps/api/scripts/refresh-ladder-map-pool.js [--summary <file>]
 *   npm run refresh-map-pool          (from apps/api)
 *
 * ``--summary`` also writes the Markdown change summary to <file> (the
 * workflow uses it as the PR body).
 */

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { LadderMapPoolService } = require("../src/services/ladderMapPool");

const SEED_PATH = path.join(__dirname, "..", "data", "ladder-map-pool.json");

/** Surfaces the service's fetch/parse warnings (status, error) on stderr. */
const STDERR_LOGGER = {
  info: () => {},
  /** @param {object} obj @param {string} msg */
  warn: (obj, msg) => console.error(`${msg} ${JSON.stringify(obj)}`),
  /** @param {object} obj @param {string} msg */
  error: (obj, msg) => console.error(`${msg} ${JSON.stringify(obj)}`),
  child: () => STDERR_LOGGER,
};

/** @param {string[]} prev @param {string[]} next */
function listDiff(prev, next) {
  return {
    added: next.filter((m) => !prev.includes(m)),
    removed: prev.filter((m) => !next.includes(m)),
  };
}

/**
 * @param {{ maps?: string[], teamMaps?: string[] } | null} seed
 * @param {{ maps: string[], teamMaps: string[] }} live
 */
function diffPools(seed, live) {
  const solo = listDiff((seed && seed.maps) || [], live.maps);
  const team = listDiff((seed && seed.teamMaps) || [], live.teamMaps);
  const changed = [solo, team].some(
    (d) => d.added.length > 0 || d.removed.length > 0,
  );
  return { solo, team, changed };
}

/**
 * @param {string} title
 * @param {{ added: string[], removed: string[] }} diff
 * @param {string[]} current
 */
function formatSection(title, diff, current) {
  const lines = [`### ${title}`, ""];
  if (diff.added.length > 0) lines.push(`- Added: ${diff.added.join(", ")}`);
  if (diff.removed.length > 0) lines.push(`- Removed: ${diff.removed.join(", ")}`);
  if (diff.added.length === 0 && diff.removed.length === 0) lines.push("- No change");
  lines.push(`- Current (${current.length}): ${current.join(", ") || "none"}`);
  return lines.join("\n");
}

/**
 * @param {ReturnType<typeof diffPools>} diff
 * @param {{ maps: string[], teamMaps: string[] }} live
 */
function formatSummary(diff, live) {
  const headline = diff.changed
    ? "The Liquipedia ladder map pool changed since the committed seed."
    : "The committed seed matches the Liquipedia ladder map pool.";
  return [
    headline,
    "",
    formatSection("1v1", diff.solo, live.maps),
    "",
    formatSection("Team (2v2 / 3v3 / 4v4)", diff.team, live.teamMaps),
    "",
  ].join("\n");
}

/** @param {string} seedPath */
async function readSeed(seedPath) {
  try {
    return JSON.parse(await fs.readFile(seedPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   seedPath?: string,
 *   summaryPath?: string | null,
 *   fetchImpl?: typeof globalThis.fetch,
 *   logger?: typeof STDERR_LOGGER,
 * }} [opts]
 * @returns {Promise<{ code: number, changed: boolean, summary: string | null }>}
 */
async function run(opts = {}) {
  const seedPath = opts.seedPath || SEED_PATH;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ladder-map-pool-"));
  const fetchedPath = path.join(tmpDir, "ladder-map-pool.json");
  try {
    // A temp persistPath, so the seed is only written when the lists
    // changed — in the service's own on-disk format, copied below.
    const svc = new LadderMapPoolService({
      fetchImpl: opts.fetchImpl,
      persistPath: fetchedPath,
      logger: /** @type {any} */ (opts.logger || STDERR_LOGGER),
    });
    const live = await svc.refresh();
    if (live.source !== "liquipedia" || live.maps.length === 0) {
      console.error(
        "Liquipedia fetch failed or parsed to no 1v1 maps (see above). "
          + "If the page loads in a browser, update parseLadderMaps in "
          + "src/services/ladderMapPool.js for the new template.",
      );
      return { code: 1, changed: false, summary: null };
    }
    const diff = diffPools(await readSeed(seedPath), live);
    const summary = formatSummary(diff, live);
    if (diff.changed) await fs.copyFile(fetchedPath, seedPath);
    if (opts.summaryPath) await fs.writeFile(opts.summaryPath, summary, "utf8");
    return { code: 0, changed: diff.changed, summary };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/** @param {string[]} argv @param {string} flag */
function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

if (require.main === module) {
  run({ summaryPath: argValue(process.argv.slice(2), "--summary") }).then(
    ({ code, summary }) => {
      if (summary) process.stdout.write(summary);
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}

module.exports = { diffPools, formatSummary, run };
