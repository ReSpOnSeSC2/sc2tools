"use strict";

/**
 * Example replays for published guide build pages.
 *
 * Only users who opted into public replay sharing (``users.replaySharing``
 * enabled with a canonical slug) can appear, and only through what their
 * public library already shows: handle (the sharing slug), display name,
 * result, map, length and date. No gameId and no opponent field is ever
 * read into an example, so a guide page cannot deep-link a private game
 * or name an opponent. The read layer re-verifies ``enabled`` at serve
 * time, so a user who stops sharing disappears before the next run.
 *
 * Query plan: sharing users come from the partial ``replaySharing.slug``
 * index; their games from ``{ userId, myBuild, date }`` (hinted) with the
 * same eligibility as the aggregate plus a stored replay file.
 */

const { GUIDE_EXAMPLES_MAX, GUIDE_CURRENT_ERA } = require("../config/guides");
const { eraExpression } = require("../util/patchEra");
const { guideGamesMatch } = require("./guideRules");
const { GUIDE_PIPELINE_MAX_MS } = require("./guideStatsPipelines");

/** Canonical sharing slug grammar (services/users.js REPLAY_SHARE_SLUG_RE). */
const SHARE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{10}$/;
const SHARE_SLUG_MAX_CHARS = 64;
/** Public display-name rules of services/users.js resolveReplaySharing. */
const DISPLAY_NAME_MAX_CHARS = 80;
const DISPLAY_NAME_FALLBACK = "SC2 Player";
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
/** Bound on the sharing-user ``$in`` list (most recently toggled first). */
const MAX_SHARING_USERS = 5000;
const MAP_MAX_CHARS = 200;
const RESULTS = new Set(["Victory", "Defeat", "Tie"]);
const EXAMPLES_INDEX = Object.freeze({ userId: 1, myBuild: 1, date: -1 });

/**
 * @typedef {object} GuideExample
 * @property {string} handle         replay-sharing slug (/players/<handle>/replays)
 * @property {string} displayName
 * @property {"Victory"|"Defeat"|"Tie"} result
 * @property {string|null} map
 * @property {number|null} durationSec
 * @property {Date} playedAt
 */

/** @typedef {{ handle: string, displayName: string }} SharingProfile */

/**
 * @param {unknown} raw
 * @returns {string}
 */
function publicDisplayName(raw) {
  if (typeof raw !== "string") return DISPLAY_NAME_FALLBACK;
  const name = raw.normalize("NFKC").replace(CONTROL_CHARS_RE, "").trim().slice(0, DISPLAY_NAME_MAX_CHARS);
  return name || DISPLAY_NAME_FALLBACK;
}

/**
 * userId → public sharing profile of every user sharing replays.
 *
 * @param {import('mongodb').Collection} users
 * @returns {Promise<Map<string, SharingProfile>>}
 */
async function loadSharingUsers(users) {
  const rows = await users
    .find(
      { "replaySharing.slug": { $type: "string" }, "replaySharing.enabled": true },
      { projection: { _id: 0, userId: 1, displayName: 1, "replaySharing.slug": 1 } },
    )
    .sort({ "replaySharing.updatedAt": -1 })
    .limit(MAX_SHARING_USERS)
    .toArray();
  /** @type {Map<string, SharingProfile>} */
  const profiles = new Map();
  for (const row of rows) {
    const slug = row.replaySharing && row.replaySharing.slug;
    if (typeof row.userId !== "string" || typeof slug !== "string") continue;
    if (slug.length > SHARE_SLUG_MAX_CHARS || !SHARE_SLUG_RE.test(slug)) continue;
    profiles.set(row.userId, { handle: slug, displayName: publicDisplayName(row.displayName) });
  }
  return profiles;
}

/**
 * Newest current-era game per (build, sharing user), newest users first,
 * GUIDE_EXAMPLES_MAX per build.
 *
 * @param {string} matchup
 * @param {string[]} buildKeys published builds
 * @param {string[]} userIds sharing users
 * @returns {Record<string, any>[]}
 */
function buildExamplesPipeline(matchup, buildKeys, userIds) {
  return [
    {
      $match: {
        ...guideGamesMatch(matchup),
        myBuild: { $type: "string", $in: buildKeys },
        userId: { $in: userIds },
        "replayFile.storedAt": { $exists: true },
      },
    },
    {
      $project: {
        _id: 0, userId: 1, build: "$myBuild", date: 1, result: 1, map: 1, durationSec: 1, era: eraExpression(),
      },
    },
    { $match: { era: GUIDE_CURRENT_ERA, date: { $type: "date" } } },
    { $sort: { date: -1 } },
    { $group: { _id: { build: "$build", userId: "$userId" }, game: { $first: "$$ROOT" } } },
    { $sort: { "game.date": -1 } },
    { $group: { _id: "$_id.build", games: { $push: "$game" } } },
    { $project: { _id: 0, build: "$_id", games: { $slice: ["$games", GUIDE_EXAMPLES_MAX] } } },
  ];
}

/**
 * @param {Record<string, any>} game
 * @param {SharingProfile} profile
 * @returns {GuideExample|null}
 */
function toExample(game, profile) {
  if (!RESULTS.has(game.result) || !(game.date instanceof Date)) return null;
  const map = typeof game.map === "string" && game.map.length > 0 && game.map.length <= MAP_MAX_CHARS
    ? game.map
    : null;
  const durationSec = typeof game.durationSec === "number" && Number.isFinite(game.durationSec) && game.durationSec >= 0
    ? Math.round(game.durationSec)
    : null;
  return {
    handle: profile.handle,
    displayName: profile.displayName,
    result: game.result,
    map,
    durationSec,
    playedAt: game.date,
  };
}

/**
 * Examples per published build of one matchup.
 *
 * Example: `await examplesForMatchup(db.games, "PvZ", ["PvZ - Stargate into Glaives"], profiles)`
 * → `Map { "PvZ - Stargate into Glaives" => [{ handle, displayName, result, … }] }`.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} matchup
 * @param {string[]} buildKeys published current-era builds
 * @param {Map<string, SharingProfile>} profiles
 * @returns {Promise<Map<string, GuideExample[]>>}
 */
async function examplesForMatchup(games, matchup, buildKeys, profiles) {
  /** @type {Map<string, GuideExample[]>} */
  const byBuild = new Map();
  if (buildKeys.length === 0 || profiles.size === 0) return byBuild;
  const rows = await games
    .aggregate(buildExamplesPipeline(matchup, buildKeys, [...profiles.keys()]), {
      allowDiskUse: true,
      maxTimeMS: GUIDE_PIPELINE_MAX_MS,
      timeoutMS: GUIDE_PIPELINE_MAX_MS,
      hint: EXAMPLES_INDEX,
    })
    .toArray();
  for (const row of rows) {
    /** @type {GuideExample[]} */
    const examples = [];
    for (const game of row.games || []) {
      const profile = profiles.get(game.userId);
      const example = profile ? toExample(game, profile) : null;
      if (example) examples.push(example);
    }
    byBuild.set(row.build, examples);
  }
  return byBuild;
}

module.exports = { loadSharingUsers, examplesForMatchup, publicDisplayName };
