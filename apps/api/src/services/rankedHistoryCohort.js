"use strict";

const { gamesMatchStage } = require("../util/parseQuery");
const { accountMatchHandles } = require("../util/accountFilter");
const { ladderRegionFromToonHandle } = require("../util/regionFromToonHandle");
const { normalizeRace } = require("./buildIntentCommon");

const RANKED_QUEUE_RACES = /** @type {Record<string, RegExp>} */ ({
  Protoss: /^\s*(?:p|prot|protoss)\s*$/i,
  Terran: /^\s*(?:t|terr|terran)\s*$/i,
  Zerg: /^\s*(?:z|zerg)\s*$/i,
  Random: /^\s*(?:r|rand|random)\s*$/i,
});

/** The ladder queue can be Random even when the replay shows a concrete race.
 * @param {string} userId @param {any} game */
function rankedHistoryCohort(userId, game) {
  const race = normalizeRace(game.myLadderRace ?? game.myRace);
  const at = new Date(game.date);
  const oneVsOne = game.matchFormat == null ? game.playerCount === 2
    : game.matchFormat === "1v1" && (game.playerCount == null || game.playerCount === 2);
  if (!race || !oneVsOne || !Number.isFinite(+at) || typeof game.myToonHandle !== "string"
    || game.isResumedFromReplay === true || game.excluded === true || game._deleted === true || game._deletionPending === true) return null;
  let handles;
  try { handles = accountMatchHandles([game.myToonHandle]); } catch { return null; }
  const handle = handles?.[0];
  if (!handle || !ladderRegionFromToonHandle(handle)) return null;
  const raceMatch = RANKED_QUEUE_RACES[race];
  return { race, handle, at, match: {
    ...gamesMatchStage(userId, {}), myToonHandle: { $in: handles }, isLadderGame: true, gameId: { $ne: game.gameId },
    $and: [
      { $or: [{ matchFormat: "1v1", playerCount: { $in: [2, null] } }, { matchFormat: null, playerCount: 2 }] },
      { $or: [{ myLadderRace: raceMatch }, { myLadderRace: null, myRace: raceMatch }] },
    ],
  } };
}

module.exports = { rankedHistoryCohort };
