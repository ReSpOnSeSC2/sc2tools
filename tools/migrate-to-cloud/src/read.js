"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

/**
 * Read every local data file the migrator cares about. Missing files
 * are fine — they're just reported as `count=0`. Bad JSON throws so
 * we never silently skip the user's primary dataset.
 *
 * @param {string} dir
 * @returns {Promise<{
 *   opponents: object,
 *   meta: object,
 *   customBuilds: object,
 *   profile: object | null,
 *   opponentsCount: number,
 *   metaBuildsCount: number,
 *   metaGamesCount: number,
 *   customBuildsCount: number,
 *   hasProfile: boolean,
 * }>}
 */
async function readAll(dir) {
  const opponents = await readJsonOptional(path.join(dir, "MyOpponentHistory.json"), {});
  const meta = await readJsonOptional(path.join(dir, "meta_database.json"), {});
  const customBuilds = await readJsonOptional(path.join(dir, "custom_builds.json"), {});
  const profile = await readJsonOptional(path.join(dir, "profile.json"), null);

  let metaGamesCount = 0;
  for (const buildName of Object.keys(meta || {})) {
    const games = (meta && meta[buildName] && meta[buildName].games) || [];
    if (Array.isArray(games)) metaGamesCount += games.length;
  }

  const customBuildsArr = Array.isArray(customBuilds && customBuilds.builds)
    ? customBuilds.builds
    : [];

  return {
    opponents,
    meta,
    customBuilds,
    profile,
    opponentsCount: Object.keys(opponents || {}).length,
    metaBuildsCount: Object.keys(meta || {}).length,
    metaGamesCount,
    customBuildsCount: customBuildsArr.length,
    hasProfile: profile !== null,
  };
}

/** @param {string} p */
async function readJsonOptional(p, fallback) {
  try {
    const buf = await fs.readFile(p, "utf8");
    if (!buf.trim()) return fallback;
    return JSON.parse(buf);
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    throw err;
  }
}

module.exports = { readAll };
