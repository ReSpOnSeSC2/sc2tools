"use strict";

/**
 * Patch era — whether a game was played on the 8-worker patch 5.0.16 or
 * in the 12-worker game around it.
 *
 * Patch 5.0.16 (live 2026-06-22) cut the starting workers from 12 to 8;
 * 5.0.17 (announced 2026-09-30) reverts it in full. The live, CURRENT era
 * is therefore the 12-worker game — every game before 5.0.16 and from
 * 5.0.17 on — and the PREVIOUS era is the 8-worker window between them.
 * The wire ids stay "after" (current) and "before" (previous) so URLs
 * (``?era=before``), stored keys and indexes keep working; only the games
 * each id covers changed (``PATCH_ERA_RULE``).
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
 *   1. string ``gameVersion`` — the replay's release string; "5.0.16.<build>"
 *      is the 8-worker game (every 5.0.16 hotfix keeps that prefix), any
 *      other string is 12-worker. It needs no 5.0.17 build number, so
 *      today's live 5.0.16 games stay 8-worker until 5.0.17 actually ships;
 *   2. else numeric ``gameBuild`` — 8-worker from the first live 5.0.16
 *      build up to the first 5.0.17 build (open-ended while that is
 *      unknown);
 *   3. else ``date`` — 8-worker from the 5.0.16 release until 5.0.17
 *      reaches the live ladder (``PATCH_5_0_17_LIVE``; open-ended while
 *      that is unknown, as the 5.0.17 PTR runs alongside live 5.0.16).
 * A row with none of the three (or a non-date ``date``) has no era: the
 * ``$match`` form matches neither era and the other two return null.
 * patchEra.test.js asserts all three agree on a matrix of rows.
 */

/** The live 12-worker game (before 5.0.16, and 5.0.17 on). */
const PATCH_ERA_AFTER = "after";
/** The 8-worker patch 5.0.16. */
const PATCH_ERA_BEFORE = "before";
/** @type {ReadonlyArray<"after" | "before">} */
const PATCH_ERAS = Object.freeze([PATCH_ERA_AFTER, PATCH_ERA_BEFORE]);
/**
 * Version of the era rule above. Rule 1 (until 2026-09-30) had "after" =
 * 5.0.16 and later; rule 2 is the 12-worker / 8-worker split. Stored era
 * labels (guide_samples) and derived priors carry it so rows written under
 * rule 1 are relabelled instead of trusted.
 */
const PATCH_ERA_RULE = 2;
// First live 5.0.16 build. New agent uploads carry the replay's exact build
// and release string, so the split follows the game version even when a
// replay's timestamp is skewed. The dates remain the compatibility fallback
// for rows uploaded before version metadata existed.
const PATCH_5_0_16_BUILD = 97364;
const PATCH_5_0_16_RELEASE = new Date("2026-06-22T19:15:00.000Z");
/** Release strings of the 8-worker game: every 5.0.16 build and hotfix. */
const EIGHT_WORKER_VERSION_RE = /^5\.0\.16\./;
/**
 * First live 5.0.17 build, which restores 12 starting workers. null until
 * the build number is known: rows with a release string never need it,
 * and until then a build-only row from 97364 on counts as 8-worker.
 * @type {number | null}
 */
const PATCH_5_0_17_BUILD = null;
/**
 * Midnight US Eastern on 2026-09-30, the day the 5.0.17 notes brought back
 * 12 workers (on the PTR first). The analyzer's "After 5.0.17 · 12
 * workers" date filter starts here, and rule-1 guide samples from this day
 * on are left to the backfill (guideSamples.relabelEraRule). It does not end
 * the 8-worker window: see ``PATCH_5_0_17_LIVE``.
 */
const PATCH_5_0_17_RELEASE = new Date("2026-09-30T04:00:00.000Z");
/**
 * When 5.0.17 reaches the live ladder: the 8-worker window's end for rows
 * with no version or build. null until known, which keeps that window
 * open, since live games stay on 5.0.16 while 5.0.17 is on the PTR. (A
 * PTR game carries its "5.0.17." release string, so it never needs this.)
 * Set it, and PATCH_5_0_17_BUILD, when the patch ships, and mirror both in
 * apps/web/lib/ladderPulse.ts (and the build in
 * apps/replay-engine/core/build_definitions.py, ``is_eight_worker_game``).
 * @type {Date | null}
 */
const PATCH_5_0_17_LIVE = null;

/** ``date`` bounds of the 8-worker window as a query operator. */
function eightWorkerDateRange() {
  return PATCH_5_0_17_LIVE === null
    ? { $gte: PATCH_5_0_16_RELEASE }
    : { $gte: PATCH_5_0_16_RELEASE, $lt: PATCH_5_0_17_LIVE };
}

/** ``gameBuild`` bounds of the 8-worker window as a query operator. */
function eightWorkerBuildRange() {
  return PATCH_5_0_17_BUILD === null
    ? { $gte: PATCH_5_0_16_BUILD }
    : { $gte: PATCH_5_0_16_BUILD, $lt: PATCH_5_0_17_BUILD };
}

/**
 * Prefer replay-authored version metadata over wall-clock time: the
 * release string, then the numeric build, then the date. The branches are
 * mutually exclusive so a row cannot land in both eras.
 *
 * Example: `games.find(buildEraMatch("after"))` → the 12-worker games.
 *
 * @param {"after" | "before"} era
 * @returns {Record<string, any>}
 */
function buildEraMatch(era) {
  const hasVersion = { gameVersion: { $type: "string" } };
  const missingVersion = { gameVersion: { $not: { $type: "string" } } };
  const missingBuild = { gameBuild: { $not: { $type: "number" } } };
  const hasBuild = { gameBuild: { $type: "number" } };
  if (era === PATCH_ERA_BEFORE) {
    return {
      $or: [
        { gameVersion: { $type: "string", $regex: EIGHT_WORKER_VERSION_RE } },
        { $and: [missingVersion, hasBuild, { gameBuild: eightWorkerBuildRange() }] },
        {
          $and: [
            missingVersion,
            missingBuild,
            { date: eightWorkerDateRange() },
          ],
        },
      ],
    };
  }
  /** @type {Record<string, any>[]} */
  const twelveWorkerBuild = [{ gameBuild: { $lt: PATCH_5_0_16_BUILD } }];
  if (PATCH_5_0_17_BUILD !== null) twelveWorkerBuild.push({ gameBuild: { $gte: PATCH_5_0_17_BUILD } });
  /** @type {Record<string, any>[]} */
  const twelveWorkerDate = [{ date: { $lt: PATCH_5_0_16_RELEASE } }];
  if (PATCH_5_0_17_LIVE !== null) twelveWorkerDate.push({ date: { $gte: PATCH_5_0_17_LIVE } });
  return {
    $or: [
      { $and: [hasVersion, { gameVersion: { $not: EIGHT_WORKER_VERSION_RE } }] },
      { $and: [missingVersion, hasBuild, { $or: twelveWorkerBuild }] },
      {
        $and: [
          missingVersion,
          missingBuild,
          { $or: twelveWorkerDate },
        ],
      },
    ],
  };
}

/**
 * @param {unknown} inWindow boolean expression: the row is 8-worker
 * @returns {Record<string, any>} "before" when in the 8-worker window, else "after"
 */
function eraOfWindowExpression(inWindow) {
  return { $cond: [inWindow, PATCH_ERA_BEFORE, PATCH_ERA_AFTER] };
}

/** @returns {Record<string, any>} the gameBuild half of the window test */
function eightWorkerBuildExpression() {
  const from = { $gte: ["$gameBuild", PATCH_5_0_16_BUILD] };
  return PATCH_5_0_17_BUILD === null
    ? from
    : { $and: [from, { $lt: ["$gameBuild", PATCH_5_0_17_BUILD] }] };
}

/** @returns {Record<string, any>} the date half of the window test */
function eightWorkerDateExpression() {
  const from = { $gte: ["$date", PATCH_5_0_16_RELEASE] };
  return PATCH_5_0_17_LIVE === null
    ? from
    : { $and: [from, { $lt: ["$date", PATCH_5_0_17_LIVE] }] };
}

/**
 * Aggregation expression evaluating to "after" | "before" | null with
 * exactly ``buildEraMatch``'s precedence (null when no branch applies,
 * e.g. a missing or non-date ``date`` with no version metadata).
 *
 * Example: `{ $project: { era: eraExpression() } }`.
 *
 * @returns {Record<string, any>}
 */
function eraExpression() {
  return {
    $switch: {
      branches: [
        {
          case: { $eq: [{ $type: "$gameVersion" }, "string"] },
          then: eraOfWindowExpression({
            $regexMatch: { input: "$gameVersion", regex: EIGHT_WORKER_VERSION_RE },
          }),
        },
        { case: { $isNumber: "$gameBuild" }, then: eraOfWindowExpression(eightWorkerBuildExpression()) },
        {
          case: { $eq: [{ $type: "$date" }, "date"] },
          then: eraOfWindowExpression(eightWorkerDateExpression()),
        },
      ],
      default: null,
    },
  };
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

/** @param {number} build @returns {boolean} */
function isEightWorkerBuild(build) {
  return build >= PATCH_5_0_16_BUILD && (PATCH_5_0_17_BUILD === null || build < PATCH_5_0_17_BUILD);
}

/**
 * Era of one game (plain JS; same precedence as ``buildEraMatch``).
 * ``date`` may be a Date (stored rows) or an ISO string (ingest payload).
 *
 * Example: `eraForGame({ gameVersion: "5.0.16.97425" })` → "before" (8 workers);
 * `eraForGame({ gameVersion: "5.0.15.96883" })` → "after" (12 workers).
 *
 * @param {{ gameBuild?: unknown, gameVersion?: unknown, date?: unknown } | null | undefined} game
 * @returns {"after" | "before" | null}
 */
function eraForGame(game) {
  const g = game || {};
  if (typeof g.gameVersion === "string") {
    return EIGHT_WORKER_VERSION_RE.test(g.gameVersion) ? PATCH_ERA_BEFORE : PATCH_ERA_AFTER;
  }
  if (typeof g.gameBuild === "number") {
    return isEightWorkerBuild(g.gameBuild) ? PATCH_ERA_BEFORE : PATCH_ERA_AFTER;
  }
  const ms = dateMs(g.date);
  if (ms === null) return null;
  const live = /** @type {Date | null} */ (PATCH_5_0_17_LIVE);
  const inWindow = ms >= PATCH_5_0_16_RELEASE.getTime() && (live === null || ms < live.getTime());
  return inWindow ? PATCH_ERA_BEFORE : PATCH_ERA_AFTER;
}

/**
 * True for a game played on the 8-worker patch 5.0.16; false for the
 * 12-worker game and for rows with no era signal at all.
 *
 * Example: `isEightWorkerGame({ gameVersion: "5.0.16.97425" })` → true.
 *
 * @param {{ gameBuild?: unknown, gameVersion?: unknown, date?: unknown } | null | undefined} game
 * @returns {boolean}
 */
function isEightWorkerGame(game) {
  return eraForGame(game) === PATCH_ERA_BEFORE;
}

module.exports = {
  PATCH_ERA_AFTER,
  PATCH_ERA_BEFORE,
  PATCH_ERAS,
  PATCH_ERA_RULE,
  PATCH_5_0_16_BUILD,
  PATCH_5_0_16_RELEASE,
  PATCH_5_0_17_BUILD,
  PATCH_5_0_17_LIVE,
  PATCH_5_0_17_RELEASE,
  buildEraMatch,
  dateMs,
  eraExpression,
  eraForGame,
  isEightWorkerGame,
};
