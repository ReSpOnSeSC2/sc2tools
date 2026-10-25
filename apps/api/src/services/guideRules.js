"use strict";

const { STATS_GAME_MATCH, isStatsGame } = require("../util/gameVisibility");

const {
  LADDER_META_BUCKET_WIDTH,
  LADDER_META_LOW_CAP,
  LADDER_META_HIGH_CAP,
  LADDER_META_MMR_BANDS,
  MMR_FLOOR,
  MMR_CEILING,
  ladderMetaBucketFor,
  ladderMetaBracketLabel,
} = require("../util/mmrBracketing");
const {
  buildNamesForMatchup,
  isGuideBuildName,
  isGuideStrategyName,
} = require("../config/guideSlugs");
const { LEAGUES, bandFromId } = require("../util/leagueBands");
const {
  AGREES_WITH_DETECTOR_MATCH,
  detectorView,
  overrideActive,
} = require("./buildIntentShape");

/**
 * Guide eligibility — the ONE definition of "a game that may feed a public
 * guide", in the two forms the pipeline needs:
 *
 *   - ``isGuideEligibleGame(game)`` / ``guideIneligibilityReason(game)``:
 *     JS, used at ingest by services/guideSamples.js (and its backfill);
 *   - ``guideGamesMatch(matchup)``: a Mongo ``$match`` over SLIM ``games``
 *     rows for the nightly aggregate (services/guideStats.js).
 * guideRules.test.js runs both over the same fixture rows and asserts
 * they select the same games.
 *
 * Build check-ins: guides describe what the replays show, never what a
 * player declared. The JS form judges the classifier's label
 * (``classifierRow``); the Mongo form keeps only rows whose label agrees
 * with the classifier (``AGREES_WITH_DETECTOR_MATCH``, a residual filter
 * after the index scan) unless the caller reads the user's own record
 * (``{ ownStats: true }``), where a confirmed check-in counts.
 *
 * A game is eligible when it is:
 *   - not a resumed replay (``isResumedFromReplay !== true``);
 *   - not relabelled by a server-side custom build (``_customBuildSlug``);
 *   - 1v1: ``playerCount`` absent or 2 AND ``matchFormat`` absent or "1v1";
 *   - ladder: ``isLadderGame === true``, or ``isLadderGame`` absent (older
 *     agents) and a numeric ``opponent.leagueId`` (the agent only stamps a
 *     league on ladder games). ``isLadderMap`` is NOT proof of ladder;
 *   - a valid matchup (both race initials in P/T/Z — Random / unknown out);
 *   - ``myBuild`` a guide build of that matchup: an exact catalog opener
 *     name (config/guideSlugs.js). The allowlist is what keeps private
 *     custom build names, "Game Too Short" and unclassified labels out.
 *
 * Index note: ``guideGamesMatch`` pins ``myBuild`` to an ``$in`` of exact
 * strings and ``opponent.race`` / ``myRace`` to case-prefix regexes, so a
 * ``{ myBuild: 1, "opponent.race": 1 }`` index yields tight bounds — the
 * only games index a cross-user guide pipeline can use (every other one
 * is userId-prefixed).
 */

/** Race initials accepted on either side of a matchup. */
const RACE_LETTERS = Object.freeze(["P", "T", "Z"]);
const MATCHUP_RE = /^[PTZ]v[PTZ]$/;
const MY_RACE_INDEX = 0;
const OPP_RACE_INDEX = 2;
const ONE_V_ONE_PLAYERS = 2;
const ONE_V_ONE_FORMAT = "1v1";

/**
 * League band values a guide may publish: the ladder league ids of
 * util/leagueBands.js (Bronze..GM), whose labels the guides reuse.
 */
/** @type {ReadonlyArray<number>} */
const GUIDE_LEAGUE_BANDS = Object.freeze(LEAGUES.map((league) => league.id));
const LEAGUE_MIN = Math.min(...GUIDE_LEAGUE_BANDS);
const LEAGUE_MAX = Math.max(...GUIDE_LEAGUE_BANDS);
/** MMR band values (opponent MMR, 500-point bands with capped tails). */
const GUIDE_MMR_BANDS = LADDER_META_MMR_BANDS;

/** Ineligibility reason codes (logged as-is; never carry PII). */
const INELIGIBLE = Object.freeze({
  EXCLUDED: "excluded",
  RESUMED: "resumed",
  CUSTOM_BUILD: "custom_build",
  NOT_1V1: "not_1v1",
  NOT_LADDER: "not_ladder",
  BAD_MATCHUP: "bad_matchup",
  NOT_GUIDE_BUILD: "not_guide_build",
});

/**
 * @param {unknown} race
 * @returns {string|null} "P" | "T" | "Z"
 */
function raceLetter(race) {
  if (typeof race !== "string" || race.length === 0) return null;
  const letter = race[0].toUpperCase();
  return RACE_LETTERS.includes(letter) ? letter : null;
}

/**
 * Matchup from the two races (first letter, case-insensitive).
 *
 * Example: `matchupOf("Protoss", "zerg")` → "PvZ"; `matchupOf("Random", "Zerg")` → null.
 *
 * @param {unknown} myRace
 * @param {unknown} oppRace
 * @returns {string|null} "PvZ" form
 */
function matchupOf(myRace, oppRace) {
  const mine = raceLetter(myRace);
  const theirs = raceLetter(oppRace);
  return mine && theirs ? `${mine}v${theirs}` : null;
}

/** @param {Record<string, any>} game */
function isOneVOne(game) {
  const players = game.playerCount;
  const format = game.matchFormat;
  return (players === undefined || players === ONE_V_ONE_PLAYERS)
    && (format === undefined || format === ONE_V_ONE_FORMAT);
}

/** @param {Record<string, any>} game */
function isLadder(game) {
  if (game.isLadderGame === true) return true;
  const opponent = game.opponent;
  return game.isLadderGame === undefined
    && Boolean(opponent)
    && typeof opponent.leagueId === "number";
}

/**
 * The row as the classifier labelled it: a confirmed check-in's declared
 * ``myBuild`` / ``_customBuildSlug`` are swapped back for the detector's
 * (an absent detector slug leaves no ``_customBuildSlug``). Rows without a
 * check-in are returned as they are.
 *
 * @param {Record<string, any>} game
 * @returns {Record<string, any>}
 */
function classifierRow(game) {
  if (!overrideActive(game)) return game;
  const view = detectorView(game);
  /** @type {Record<string, any>} */
  const row = { ...game, myBuild: view.myBuild };
  if (view.customBuildSlug === null) delete row._customBuildSlug;
  else row._customBuildSlug = view.customBuildSlug;
  return row;
}

/**
 * Why a game cannot feed a guide, or null when it can. Judged on the
 * classifier's label (``classifierRow``), never a build check-in.
 *
 * Example: `guideIneligibilityReason({ ...game, playerCount: 4 })` → "not_1v1".
 *
 * @param {unknown} raw ingest payload or slim games row
 * @returns {string|null} one of INELIGIBLE's codes, or null
 */
function guideIneligibilityReason(raw) {
  if (!raw || typeof raw !== "object") return INELIGIBLE.BAD_MATCHUP;
  if (!isStatsGame(raw)) return INELIGIBLE.EXCLUDED;
  const game = classifierRow(/** @type {Record<string, any>} */ (raw));
  if (game.isResumedFromReplay === true) return INELIGIBLE.RESUMED;
  if (game._customBuildSlug !== undefined) return INELIGIBLE.CUSTOM_BUILD;
  if (!isOneVOne(game)) return INELIGIBLE.NOT_1V1;
  if (!isLadder(game)) return INELIGIBLE.NOT_LADDER;
  const matchup = matchupOf(game.myRace, game.opponent && game.opponent.race);
  if (!matchup) return INELIGIBLE.BAD_MATCHUP;
  if (!isGuideBuildName(matchup, game.myBuild)) return INELIGIBLE.NOT_GUIDE_BUILD;
  return null;
}

/**
 * JS eligibility predicate (see the module comment for the rules).
 *
 * @param {unknown} game
 * @returns {boolean}
 */
function isGuideEligibleGame(game) {
  return guideIneligibilityReason(game) === null;
}

/**
 * Case-insensitive prefix regexes for one race letter. Two anchored,
 * case-sensitive regexes (not /^p/i) so the planner derives index bounds.
 *
 * @param {string} letter
 * @returns {RegExp[]}
 */
function racePrefixRegexes(letter) {
  return [new RegExp(`^${letter}`), new RegExp(`^${letter.toLowerCase()}`)];
}

/**
 * ``$match`` selecting the slim games rows of one matchup that may feed a
 * guide — same semantics as ``isGuideEligibleGame``, except that a row
 * whose build check-in disagrees with the classifier is left out (the
 * index cannot see the detector's label). Intentionally no ``userId``
 * predicate: guides aggregate across every account.
 *
 * ``ownStats: true`` (a user's own record, services/guidesPersonal.js)
 * keeps those rows: a confirmed check-in counts toward the declared build.
 *
 * Example: `games.aggregate([{ $match: guideGamesMatch("PvZ") }, …])`.
 *
 * @param {string} matchup "PvZ" form
 * @param {{ ownStats?: boolean }} [opts]
 * @returns {Record<string, any>}
 */
function guideGamesMatch(matchup, opts = {}) {
  if (typeof matchup !== "string" || !MATCHUP_RE.test(matchup)) {
    throw new TypeError(`guideGamesMatch: invalid matchup "${String(matchup)}"`);
  }
  return {
    myBuild: { $type: "string", $in: [...buildNamesForMatchup(matchup)] },
    "opponent.race": { $in: racePrefixRegexes(matchup[OPP_RACE_INDEX]) },
    myRace: { $in: racePrefixRegexes(matchup[MY_RACE_INDEX]) },
    ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true },
    _customBuildSlug: { $exists: false },
    $and: [
      { $or: [{ playerCount: { $exists: false } }, { playerCount: ONE_V_ONE_PLAYERS }] },
      { $or: [{ matchFormat: { $exists: false } }, { matchFormat: ONE_V_ONE_FORMAT }] },
      {
        $or: [
          { isLadderGame: true },
          { isLadderGame: { $exists: false }, "opponent.leagueId": { $type: "number" } },
        ],
      },
      ...(opts.ownStats === true ? [] : [AGREES_WITH_DETECTOR_MATCH]),
    ],
  };
}

/**
 * True when an ``opponent.strategy`` label may be shown on a guide for the
 * user's matchup (exact catalog opener in the matchup's counters namespace).
 *
 * Example: `strategyAllowed("PvZ", "Zerg - 12 Pool")` → true.
 *
 * @param {string} matchup
 * @param {unknown} strategy
 * @returns {boolean}
 */
function strategyAllowed(matchup, strategy) {
  return isGuideStrategyName(matchup, strategy);
}

/**
 * League band of an opponent: the ladder league enum (0 Bronze … 6 GM).
 *
 * Example: `leagueBandOf({ leagueId: 4 })` → 4; `leagueBandOf({ leagueId: 9 })` → null.
 *
 * @param {unknown} opponent
 * @returns {number|null}
 */
function leagueBandOf(opponent) {
  const id = opponent && typeof opponent === "object"
    ? /** @type {Record<string, unknown>} */ (opponent).leagueId
    : undefined;
  if (typeof id !== "number" || !Number.isInteger(id)) return null;
  return id >= LEAGUE_MIN && id <= LEAGUE_MAX ? id : null;
}

/**
 * MMR band of an opponent (ladderMeta's capped 500-point bands).
 *
 * Example: `mmrBandOf({ mmr: 4120 })` → 4000; `mmrBandOf({ mmr: 900 })` → null.
 *
 * @param {unknown} opponent
 * @returns {number|null}
 */
function mmrBandOf(opponent) {
  const mmr = opponent && typeof opponent === "object"
    ? /** @type {Record<string, unknown>} */ (opponent).mmr
    : undefined;
  return typeof mmr === "number" ? ladderMetaBucketFor(mmr) : null;
}

/**
 * Aggregation mirror of ``leagueBandOf`` over ``$opponent.leagueId``.
 *
 * @returns {Record<string, any>} int 0..6 or null
 */
function leagueBandExpression() {
  const id = "$opponent.leagueId";
  return {
    $cond: [
      {
        $and: [
          { $isNumber: id },
          { $eq: [id, { $trunc: id }] },
          { $gte: [id, LEAGUE_MIN] },
          { $lte: [id, LEAGUE_MAX] },
        ],
      },
      { $toInt: id },
      null,
    ],
  };
}

/**
 * Aggregation mirror of ``mmrBandOf`` over ``$opponent.mmr``.
 *
 * @returns {Record<string, any>} band floor or null
 */
function mmrBandExpression() {
  const mmr = "$opponent.mmr";
  const bucket = {
    $multiply: [{ $floor: { $divide: [mmr, LADDER_META_BUCKET_WIDTH] } }, LADDER_META_BUCKET_WIDTH],
  };
  return {
    $cond: [
      { $and: [{ $isNumber: mmr }, { $gte: [mmr, MMR_FLOOR] }, { $lt: [mmr, MMR_CEILING] }] },
      {
        $switch: {
          branches: [
            { case: { $lt: [bucket, LADDER_META_LOW_CAP] }, then: MMR_FLOOR },
            { case: { $gte: [bucket, LADDER_META_HIGH_CAP] }, then: LADDER_META_HIGH_CAP },
          ],
          default: bucket,
        },
      },
      null,
    ],
  };
}

/**
 * Example: `leagueLabel(4)` → "Diamond"; `leagueLabel(9)` → "League 9".
 *
 * @param {number} id
 * @returns {string}
 */
function leagueLabel(id) {
  const band = Number.isInteger(id) ? bandFromId(id) : null;
  return band ? band.label : `League ${id}`;
}

/**
 * Example: `mmrBandLabel(4000)` → "4000–4500"; `mmrBandLabel(1000)` → "<2000".
 *
 * @param {number} band
 * @returns {string|null} null for a value that is not an MMR band
 */
function mmrBandLabel(band) {
  return ladderMetaBracketLabel(band);
}

module.exports = {
  RACE_LETTERS,
  GUIDE_LEAGUE_BANDS,
  GUIDE_MMR_BANDS,
  INELIGIBLE,
  matchupOf,
  classifierRow,
  guideIneligibilityReason,
  isGuideEligibleGame,
  guideGamesMatch,
  strategyAllowed,
  leagueBandOf,
  mmrBandOf,
  leagueBandExpression,
  mmrBandExpression,
  leagueLabel,
  mmrBandLabel,
};
