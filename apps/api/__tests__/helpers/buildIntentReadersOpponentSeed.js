// @ts-nocheck
"use strict";

/**
 * Fixture rows for the opponent-axis build check-in reader suites
 * (buildIntentReadersOpponent*.test.js). Every row is a PvZ ladder game the
 * classifier labelled 2 Stargate Phoenix on the "you" axis (no "you"
 * check-in), so only the opponent axis varies:
 *
 *   id                detector label                 correction        result
 *   "opp-normal"      12 Pool                        none              Victory
 *   "opp-disagree"    1 Base Roach Rush              12 Pool           Defeat
 *   "opp-agree"       12 Pool                        12 Pool           Victory
 *   "opp-custom"      12 Pool                        custom Pool First Defeat
 *   "opp-from-custom" custom Roach Rush (roach-rush) 12 Pool           Victory
 *
 * Effective (own-stats) labels: 12 Pool ×4 (2 only because of a
 * correction), Pool First ×1. Detector labels: 12 Pool ×3, 1 Base Roach
 * Rush ×1, Roach Rush ×1. Agreeing on the opponent axis: "opp-normal",
 * "opp-agree".
 *
 * Corrections go through the production pipelines, one atomic update with
 * the check-in notes (``buildIntent.notes``) so leak checks bite.
 */

const {
  applyOpponentOverridePipeline,
  mergeIntentPipeline,
} = require("../../src/services/buildIntentAttribution");
const { catalogKeyForName, customKeyForSlug } = require("../../src/services/buildIntentShape");
const { STARGATE, SECRET_NOTES, slimGame } = require("./buildIntentReadersSeed");

const POOL = "Zerg - 12 Pool";
const ROACH = "Zerg - 1 Base Roach Rush";
const CUSTOM_ROACH = "Roach Rush";
const POOL_FIRST = "Pool First";
const OPP_IDS = Object.freeze(["opp-normal", "opp-disagree", "opp-agree", "opp-custom", "opp-from-custom"]);

/** @type {{key: string, name: string, slug: null, source: "catalog"}} */
const POOL_REF = Object.freeze({
  key: catalogKeyForName(POOL),
  name: POOL,
  slug: null,
  source: "catalog",
});

/** @type {{key: string, name: string, slug: string, source: "custom"}} */
const POOL_FIRST_REF = Object.freeze({
  key: customKeyForSlug("pool-first"),
  name: POOL_FIRST,
  slug: "pool-first",
  source: "custom",
});

/**
 * Write a confirmed opponent correction (plus check-in notes) onto a row.
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} gameId
 * @param {Record<string, any>} build BuildRef
 */
async function correctOpponent(games, userId, gameId, build = POOL_REF) {
  const at = new Date("2026-10-10T18:30:00.000Z");
  const res = await games.updateOne({ userId, gameId }, [
    // Notes only: a "you" check-in already on the row keeps its status.
    ...mergeIntentPipeline({ notes: SECRET_NOTES }),
    ...applyOpponentOverridePipeline(build, {
      origin: "web",
      via: "web",
      confirmedAt: at,
      updatedAt: at,
    }),
  ]);
  if (res.matchedCount !== 1) throw new Error(`correctOpponent: no row ${gameId}`);
}

/**
 * One PvZ row with the given opponent label.
 * @param {string} userId
 * @param {string} gameId
 * @param {number} day October day of the game
 * @param {Record<string, any>} [fields]
 */
function oppGame(userId, gameId, day, fields = {}) {
  const base = slimGame(userId, gameId, {
    myBuild: STARGATE,
    date: new Date(`2026-10-${String(day).padStart(2, "0")}T18:00:00.000Z`),
  });
  return {
    ...base,
    ...fields,
    opponent: { ...base.opponent, ...(fields.opponent || {}) },
  };
}

/**
 * Seed the five standard opponent-axis rows for ``userId``.
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {(row: Record<string, any>) => Record<string, any>} [shape] per-row tweak
 */
async function seedOpponentAxis(games, userId, shape = (row) => row) {
  await games.insertMany([
    shape(oppGame(userId, "opp-normal", 10, { opponent: { strategy: POOL } })),
    shape(oppGame(userId, "opp-disagree", 11, { result: "Defeat", opponent: { strategy: ROACH } })),
    shape(oppGame(userId, "opp-agree", 12, { opponent: { strategy: POOL } })),
    shape(oppGame(userId, "opp-custom", 13, { result: "Defeat", opponent: { strategy: POOL } })),
    shape(oppGame(userId, "opp-from-custom", 14, {
      opponent: { strategy: CUSTOM_ROACH },
      _customOpponentStrategySlug: "roach-rush",
    })),
  ]);
  await correctOpponent(games, userId, "opp-disagree");
  await correctOpponent(games, userId, "opp-agree");
  await correctOpponent(games, userId, "opp-custom", POOL_FIRST_REF);
  await correctOpponent(games, userId, "opp-from-custom");
}

module.exports = {
  POOL,
  ROACH,
  CUSTOM_ROACH,
  POOL_FIRST,
  OPP_IDS,
  POOL_REF,
  POOL_FIRST_REF,
  correctOpponent,
  oppGame,
  seedOpponentAxis,
};
