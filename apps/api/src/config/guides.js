"use strict";

/**
 * SC2 Tools Guides — shared constants.
 *
 * One place for every floor, cap and window the guides pipeline uses, so
 * the capture path (services/guideSamples.js), the nightly aggregate
 * (services/guideStats.js) and the public read layer (services/guides.js)
 * can never disagree about what "enough data" means.
 *
 * Floors (ALL DATA IS REAL): a number is only ever published when it is
 * backed by at least GUIDE_CELL_MIN_GAMES games from GUIDE_CELL_MIN_USERS
 * distinct users. Below the floor the API returns nothing for that cell —
 * never a padded, smoothed or invented value.
 *
 * The four floors can be lowered or raised per deployment with
 * GUIDES_CELL_MIN_USERS, GUIDES_CELL_MIN_GAMES, GUIDES_PAGE_MIN_USERS and
 * GUIDES_PAGE_MIN_GAMES (whole numbers >= 1; anything else keeps the
 * default). A page floor is never below the matching cell floor, because a
 * page's headline number is itself a cell. Read once at startup.
 */

const { PATCH_ERA_AFTER } = require("../util/patchEra");

const DAY_SEC = 24 * 60 * 60;
const DAY_MS = DAY_SEC * 1000;

/**
 * A floor from ``env[name]`` when it is a whole number >= 1, else
 * ``fallback``.
 *
 * Example: `floorFromEnv({ GUIDES_PAGE_MIN_GAMES: "50" }, "GUIDES_PAGE_MIN_GAMES", 100)` → 50;
 * `"0"`, `"2.5"`, `"lots"` or unset → 100.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function floorFromEnv(env, name, fallback) {
  const raw = String(env[name] ?? "").trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

/**
 * The four publish floors for ``env`` (defaults: cells 5 users / 30 games,
 * pages 5 users / 100 games).
 *
 * Example: `guideFloors({ GUIDES_PAGE_MIN_USERS: "1", GUIDES_PAGE_MIN_GAMES: "50" })`
 * → `{ cellMinUsers: 5, cellMinGames: 30, pageMinUsers: 5, pageMinGames: 50 }`
 * (the page user floor is lifted back to the cell's 5).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ cellMinUsers: number, cellMinGames: number, pageMinUsers: number, pageMinGames: number }}
 */
function guideFloors(env) {
  const cellMinUsers = floorFromEnv(env, "GUIDES_CELL_MIN_USERS", 5);
  const cellMinGames = floorFromEnv(env, "GUIDES_CELL_MIN_GAMES", 30);
  return {
    cellMinUsers,
    cellMinGames,
    pageMinUsers: Math.max(floorFromEnv(env, "GUIDES_PAGE_MIN_USERS", 5), cellMinUsers),
    pageMinGames: Math.max(floorFromEnv(env, "GUIDES_PAGE_MIN_GAMES", 100), cellMinGames),
  };
}

const FLOORS = guideFloors(process.env);

/** Minimum distinct users behind any displayed number group ("cell"). */
const GUIDE_CELL_MIN_USERS = FLOORS.cellMinUsers;
/** Minimum games behind any displayed number group ("cell"). */
const GUIDE_CELL_MIN_GAMES = FLOORS.cellMinGames;

/** Minimum distinct users for a build/counter/map page to be published (current era, whole page). */
const GUIDE_PAGE_MIN_USERS = FLOORS.pageMinUsers;
/** Minimum games for a build/counter/map page to be published (current era, whole page). */
const GUIDE_PAGE_MIN_GAMES = FLOORS.pageMinGames;

/**
 * Max games one user contributes per build per era. Poisoning resistance:
 * a single prolific (or malicious) uploader cannot move a cell further
 * than this many games can.
 */
const GUIDE_USER_CELL_CAP = 50;

/** A milestone is shown only when at least this share of samples reached it. */
const GUIDE_MILESTONE_MIN_PRESENCE = 0.6;

/** Army snapshot checkpoints (game seconds): 6:00, 8:00, 10:00. */
const GUIDE_ARMY_CHECKPOINTS_SEC = Object.freeze([360, 480, 600]);
/** Max distance between a unit_timeline sample and a checkpoint. */
const GUIDE_ARMY_TOLERANCE_SEC = 15;
/** Unit types kept per army checkpoint (largest counts first). */
const GUIDE_ARMY_TOP_UNITS = 8;

/**
 * @typedef {{ key: string, minSec: number, maxSec: number|null }} GuideLengthBucket
 */

/** Game-length buckets (half-open [minSec, maxSec); null = open-ended). */
const GUIDE_LENGTH_BUCKETS = /** @type {ReadonlyArray<Readonly<GuideLengthBucket>>} */ (Object.freeze([
  Object.freeze({ key: "0-6", minSec: 0, maxSec: 360 }),
  Object.freeze({ key: "6-10", minSec: 360, maxSec: 600 }),
  Object.freeze({ key: "10-15", minSec: 600, maxSec: 900 }),
  Object.freeze({ key: "15-20", minSec: 900, maxSec: 1200 }),
  Object.freeze({ key: "20+", minSec: 1200, maxSec: null }),
]));

/** guide_samples rows expire this long after their first capture (TTL index). */
const GUIDE_SAMPLE_TTL_SEC = 400 * DAY_SEC;

/** z-score of the 95% Wilson score interval. */
const GUIDE_WILSON_Z = 1.96;

/** Week-over-week baseline rotation: a baseline is replaced once it is this old. */
const GUIDE_BASELINE_MIN_AGE_MS = 7 * DAY_MS;

/** "What's winning" rows per matchup on the hub. */
const GUIDE_TOP_WINNING = 3;
/** Example replays per build page. */
const GUIDE_EXAMPLES_MAX = 3;
/** Coach's-note body length cap (characters). */
const GUIDE_NOTE_MAX_CHARS = 4000;

/** Cache-Control on every public guides response. */
const GUIDE_CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";

/** The live patch era (util/patchEra.js: the 12-worker game) and the live
 *  patch's label. The web words each era by worker count, not by this. */
const GUIDE_CURRENT_ERA = PATCH_ERA_AFTER;
const GUIDE_PATCH_LABEL = "5.0.17";

module.exports = {
  guideFloors,
  GUIDE_CELL_MIN_USERS,
  GUIDE_CELL_MIN_GAMES,
  GUIDE_PAGE_MIN_USERS,
  GUIDE_PAGE_MIN_GAMES,
  GUIDE_USER_CELL_CAP,
  GUIDE_MILESTONE_MIN_PRESENCE,
  GUIDE_ARMY_CHECKPOINTS_SEC,
  GUIDE_ARMY_TOLERANCE_SEC,
  GUIDE_ARMY_TOP_UNITS,
  GUIDE_LENGTH_BUCKETS,
  GUIDE_SAMPLE_TTL_SEC,
  GUIDE_WILSON_Z,
  GUIDE_BASELINE_MIN_AGE_MS,
  GUIDE_TOP_WINNING,
  GUIDE_EXAMPLES_MAX,
  GUIDE_NOTE_MAX_CHARS,
  GUIDE_CACHE_CONTROL,
  GUIDE_CURRENT_ERA,
  GUIDE_PATCH_LABEL,
};
