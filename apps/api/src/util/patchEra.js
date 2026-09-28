"use strict";

/**
 * Patch era — which side of the 5.0.16 balance patch a game was played on.
 *
 * Shared by the Ladder Meta Radar (services/ladderMeta.js) and the guides
 * pipeline (services/guideSamples.js at ingest, services/guideStats.js in
 * the nightly aggregate). Three equivalent forms of ONE rule:
 *
 *   - ``buildEraMatch(era)``  query ``$match`` (ladderMeta's original form)
 *   - ``eraExpression()``     aggregation expression → "after" | "before" | null
 *   - ``eraForGame(game)``    plain JS → "after" | "before" | null
 *
 * Precedence (mutually exclusive, most authoritative first):
 *   1. numeric ``gameBuild``  — monotonic replay build, compared to the
 *      first live 5.0.16 build;
 *   2. else string ``gameVersion`` — its last dot segment parsed as an int
 *      (an unparsable segment counts as -1, i.e. always "before");
 *   3. else ``date`` against the patch release instant.
 * A row with none of the three (or a non-date ``date``) has no era: the
 * ``$match`` form matches neither era and the other two return null.
 * patchEra.test.js asserts all three agree on a matrix of rows.
 */

const PATCH_ERA_AFTER = "after";
const PATCH_ERA_BEFORE = "before";
/** @type {ReadonlyArray<"after" | "before">} */
const PATCH_ERAS = Object.freeze([PATCH_ERA_AFTER, PATCH_ERA_BEFORE]);
// First live 5.0.16 build. New agent uploads carry the replay's exact build
// and release string, so the meta split follows the game version even when a
// replay's timestamp is skewed. The release instant remains the compatibility
// fallback for rows uploaded before version metadata existed.
const PATCH_5_0_16_BUILD = 97364;
const PATCH_5_0_16_RELEASE = new Date("2026-06-22T19:15:00.000Z");

/** ``$convert`` fallback for an unparsable version segment (always "before"). */
const UNPARSABLE_VERSION_BUILD = -1;
/** Mongo's ``$convert … to: "int"`` accepts only 32-bit signed integers. */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INTEGER_STRING_RE = /^[+-]?\d+$/;

/** The same last-dot-segment parse the aggregation performs. */
const VERSION_BUILD_EXPRESSION = Object.freeze({
  $convert: {
    input: { $arrayElemAt: [{ $split: ["$gameVersion", "."] }, -1] },
    to: "int",
    onError: UNPARSABLE_VERSION_BUILD,
    onNull: UNPARSABLE_VERSION_BUILD,
  },
});

/**
 * Prefer replay-authored version metadata over wall-clock time. ``gameBuild``
 * is monotonic and therefore authoritative. ``gameVersion`` covers partially
 * upgraded producers, while ``date`` keeps the historical corpus queryable.
 * The branches are mutually exclusive so a row cannot land in both eras.
 *
 * Example: `games.find(buildEraMatch("after"))`.
 *
 * @param {"after" | "before"} era
 * @returns {Record<string, any>}
 */
function buildEraMatch(era) {
  const missingBuild = { gameBuild: { $not: { $type: "number" } } };
  const missingVersion = { gameVersion: { $not: { $type: "string" } } };
  const versionBuild = VERSION_BUILD_EXPRESSION;
  if (era === PATCH_ERA_BEFORE) {
    return {
      $or: [
        { gameBuild: { $type: "number", $lt: PATCH_5_0_16_BUILD } },
        {
          $and: [
            missingBuild,
            { gameVersion: { $type: "string" } },
            { $expr: { $lt: [versionBuild, PATCH_5_0_16_BUILD] } },
          ],
        },
        {
          $and: [
            missingBuild,
            missingVersion,
            { date: { $lt: PATCH_5_0_16_RELEASE } },
          ],
        },
      ],
    };
  }
  return {
    $or: [
      { gameBuild: { $type: "number", $gte: PATCH_5_0_16_BUILD } },
      {
        $and: [
          missingBuild,
          { gameVersion: { $type: "string" } },
          { $expr: { $gte: [versionBuild, PATCH_5_0_16_BUILD] } },
        ],
      },
      {
        $and: [
          missingBuild,
          missingVersion,
          { date: { $gte: PATCH_5_0_16_RELEASE } },
        ],
      },
    ],
  };
}

/**
 * @param {unknown} build numeric expression result
 * @returns {Record<string, any>} "after" when ≥ the 5.0.16 build, else "before"
 */
function eraOfBuildExpression(build) {
  return { $cond: [{ $gte: [build, PATCH_5_0_16_BUILD] }, PATCH_ERA_AFTER, PATCH_ERA_BEFORE] };
}

/**
 * Aggregation expression evaluating to "after" | "before" | null with
 * exactly ``buildEraMatch``'s precedence (null when no branch applies,
 * e.g. a missing or non-date ``date`` with no build metadata).
 *
 * Example: `{ $project: { era: eraExpression() } }`.
 *
 * @returns {Record<string, any>}
 */
function eraExpression() {
  return {
    $switch: {
      branches: [
        { case: { $isNumber: "$gameBuild" }, then: eraOfBuildExpression("$gameBuild") },
        {
          case: { $eq: [{ $type: "$gameVersion" }, "string"] },
          then: eraOfBuildExpression(VERSION_BUILD_EXPRESSION),
        },
        {
          case: { $eq: [{ $type: "$date" }, "date"] },
          then: {
            $cond: [{ $gte: ["$date", PATCH_5_0_16_RELEASE] }, PATCH_ERA_AFTER, PATCH_ERA_BEFORE],
          },
        },
      ],
      default: null,
    },
  };
}

/**
 * JS mirror of ``$convert``'s string → int on the last version segment.
 *
 * @param {string} gameVersion e.g. "5.0.16.97425"
 * @returns {number} the build, or -1 when the segment is not a 32-bit integer
 */
function versionBuildOf(gameVersion) {
  const parts = gameVersion.split(".");
  const last = parts[parts.length - 1];
  if (!INTEGER_STRING_RE.test(last)) return UNPARSABLE_VERSION_BUILD;
  const n = Number(last);
  return n >= INT32_MIN && n <= INT32_MAX ? n : UNPARSABLE_VERSION_BUILD;
}

/**
 * @param {unknown} date Date or ISO string
 * @returns {number|null} epoch ms, or null when not a valid instant
 */
function dateMs(date) {
  if (date instanceof Date) return Number.isNaN(date.getTime()) ? null : date.getTime();
  if (typeof date !== "string") return null;
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Era of one game (plain JS; same precedence as ``buildEraMatch``).
 * ``date`` may be a Date (stored rows) or an ISO string (ingest payload).
 *
 * Example: `eraForGame({ gameVersion: "5.0.16.97425" })` → "after".
 *
 * @param {{ gameBuild?: unknown, gameVersion?: unknown, date?: unknown }} game
 * @returns {"after" | "before" | null}
 */
function eraForGame(game) {
  const g = game || {};
  if (typeof g.gameBuild === "number") {
    return g.gameBuild >= PATCH_5_0_16_BUILD ? PATCH_ERA_AFTER : PATCH_ERA_BEFORE;
  }
  if (typeof g.gameVersion === "string") {
    return versionBuildOf(g.gameVersion) >= PATCH_5_0_16_BUILD ? PATCH_ERA_AFTER : PATCH_ERA_BEFORE;
  }
  const ms = dateMs(g.date);
  if (ms === null) return null;
  return ms >= PATCH_5_0_16_RELEASE.getTime() ? PATCH_ERA_AFTER : PATCH_ERA_BEFORE;
}

module.exports = {
  PATCH_ERA_AFTER,
  PATCH_ERA_BEFORE,
  PATCH_ERAS,
  PATCH_5_0_16_BUILD,
  PATCH_5_0_16_RELEASE,
  buildEraMatch,
  dateMs,
  eraExpression,
  eraForGame,
};
