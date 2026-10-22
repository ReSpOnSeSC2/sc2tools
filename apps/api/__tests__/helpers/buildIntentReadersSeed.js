// @ts-nocheck
"use strict";

/**
 * Fixture rows for the build check-in reader suites
 * (buildIntentReaders*.test.js). Every suite seeds the same three shapes:
 *
 *   - "normal":   the classifier labelled the game, no check-in;
 *   - "disagree": a confirmed check-in whose replay was classified as
 *                 something else (counts only because of the check-in);
 *   - "agree":    a confirmed check-in the replay matched anyway.
 *
 * Overrides are written with the production ``applyOverridePipeline`` so
 * ``buildIntent.detected`` is captured exactly as the check-in routes do.
 */

const { applyOverridePipeline } = require("../../src/services/buildIntentAttribution");
const { catalogKeyForName, customKeyForSlug } = require("../../src/services/buildIntentShape");

const STARGATE = "PvZ - 2 Stargate Phoenix";
const VOID_RAY = "PvZ - 2 Stargate Void Ray";
const UNCLASSIFIED = "PvZ - Macro Transition (Unclassified)";
const SECRET_NOTES = "secret plan notes: proxy pylon behind the mineral line";

/** @type {{key: string, name: string, slug: null, source: "catalog"}} */
const STARGATE_REF = Object.freeze({
  key: catalogKeyForName(STARGATE),
  name: STARGATE,
  slug: null,
  source: "catalog",
});

/** @type {{key: string, name: string, slug: string, source: "custom"}} */
const DT_REF = Object.freeze({
  key: customKeyForSlug("dt-rush"),
  name: "DT Rush",
  slug: "dt-rush",
  source: "custom",
});

/**
 * One slim ladder PvZ row (current patch era, guide- and meta-eligible).
 * @param {string} userId
 * @param {string} gameId
 * @param {Record<string, any>} [fields]
 */
function slimGame(userId, gameId, fields = {}) {
  return {
    userId,
    gameId,
    date: new Date("2026-10-10T18:00:00.000Z"),
    result: "Victory",
    myRace: "Protoss",
    map: "Site Delta LE",
    durationSec: 640,
    playerCount: 2,
    matchFormat: "1v1",
    isLadderGame: true,
    gameVersion: "5.0.14.93272",
    myMmr: 4100,
    macroScore: 70,
    opponent: {
      displayName: "Opp",
      race: "Zerg",
      leagueId: 4,
      mmr: 4120,
      strategy: "Zerg - 12 Pool",
      pulseId: "1-S2-1-777",
    },
    ...fields,
  };
}

/** @param {Record<string, unknown>} [extra] */
function intentPatch(extra = {}) {
  const at = new Date("2026-10-10T18:30:00.000Z");
  return {
    origin: "web",
    via: "web",
    gameKey: null,
    randomizer: null,
    suggestion: null,
    notes: SECRET_NOTES,
    confirmedAt: at,
    updatedAt: at,
    ...extra,
  };
}

/**
 * Write a confirmed check-in onto an existing row.
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} gameId
 * @param {Record<string, any>} build BuildRef
 */
async function checkIn(games, userId, gameId, build = STARGATE_REF) {
  const res = await games.updateOne({ userId, gameId }, applyOverridePipeline(build, intentPatch()));
  if (res.matchedCount !== 1) throw new Error(`checkIn: no row ${gameId}`);
}

/**
 * Seed the three standard shapes for ``userId`` (ids "normal", "disagree",
 * "agree"), all labelled STARGATE after the check-ins.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {(row: Record<string, any>) => Record<string, any>} [shape] per-row tweak
 */
async function seedThree(games, userId, shape = (row) => row) {
  await games.insertMany([
    shape(slimGame(userId, "normal", { myBuild: STARGATE, date: new Date("2026-10-10T18:00:00.000Z") })),
    shape(slimGame(userId, "disagree", {
      myBuild: UNCLASSIFIED,
      result: "Defeat",
      date: new Date("2026-10-11T18:00:00.000Z"),
    })),
    shape(slimGame(userId, "agree", { myBuild: STARGATE, date: new Date("2026-10-12T18:00:00.000Z") })),
  ]);
  await checkIn(games, userId, "disagree");
  await checkIn(games, userId, "agree");
}

module.exports = {
  STARGATE,
  VOID_RAY,
  UNCLASSIFIED,
  SECRET_NOTES,
  STARGATE_REF,
  DT_REF,
  slimGame,
  intentPatch,
  checkIn,
  seedThree,
};
