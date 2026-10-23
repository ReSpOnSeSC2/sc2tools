"use strict";

const { gamesMatchStage } = require("../util/parseQuery");

const FACET_TTL_MS = 10 * 60 * 1000;
const FACET_CACHE_MAX = 500;
const resultText = { $toLower: { $convert: { input: "$result", to: "string", onNull: "", onError: "" } } };
const raceLetter = (/** @type {string} */ field) => ({ $toUpper: { $substrCP: [{ $convert: { input: field, to: "string", onNull: "", onError: "" } }, 0, 1] } });

/** Summary uses the exact filter match before pagination; facets use no filters. */
async function readArchiveOverview(/** @type {import('mongodb').Collection} */ games, /** @type {string} */ ownerId, /** @type {Record<string, any>} */ match, /** @type {Map<string, any>} */ cache) {
  const [rows, facets] = await Promise.all([
    games.aggregate([{ $match: match }, { $group: {
      _id: null, total: { $sum: 1 },
      wins: { $sum: { $cond: [{ $in: [resultText, ["win", "victory"]] }, 1, 0] } },
      losses: { $sum: { $cond: [{ $in: [resultText, ["loss", "defeat"]] }, 1, 0] } },
      ties: { $sum: { $cond: [{ $in: [resultText, ["tie", "draw"]] }, 1, 0] } },
      avgDurationSec: { $avg: { $cond: [{ $and: [{ $isNumber: "$durationSec" }, { $gte: ["$durationSec", 0] }, { $lte: ["$durationSec", 86_400] }] }, "$durationSec", null] } },
    } }, { $project: { _id: 0 } }]).toArray(),
    cachedFacets(games, ownerId, cache).catch(() => undefined),
  ]);
  const summary = rows[0] || { total: 0, wins: 0, losses: 0, ties: 0, avgDurationSec: null };
  return { summary, ...(facets ? { facets } : {}) };
}

/** A bounded LRU also deduplicates concurrent facet reads for the same owner. */
async function cachedFacets(/** @type {import('mongodb').Collection} */ games, /** @type {string} */ ownerId, /** @type {Map<string, any>} */ cache) {
  const cached = cache.get(ownerId);
  if (cached && cached.expires > Date.now()) { cache.delete(ownerId); cache.set(ownerId, cached); return cached.value; }
  cache.delete(ownerId);
  const entry = { expires: Date.now() + FACET_TTL_MS, value: loadFacets(games, ownerId) };
  cache.set(ownerId, entry);
  while (cache.size > FACET_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  try { return await entry.value; }
  catch (error) { if (cache.get(ownerId) === entry) cache.delete(ownerId); throw error; }
}

async function loadFacets(/** @type {import('mongodb').Collection} */ games, /** @type {string} */ ownerId) {
  const [row] = await games.aggregate([
    { $match: gamesMatchStage(ownerId, {}) },
    { $facet: {
      maps: [{ $match: { map: { $type: "string", $ne: "" } } }, { $group: { _id: "$map", count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 30 }],
      matchups: [{ $project: { mine: raceLetter("$myRace"), theirs: raceLetter("$opponent.race") } }, { $match: { mine: { $in: ["P", "T", "Z", "R"] }, theirs: { $in: ["P", "T", "Z", "R"] } } }, { $group: { _id: { $concat: ["$mine", "v", "$theirs"] } } }, { $sort: { _id: 1 } }],
    } },
  ]).toArray();
  return { maps: (row?.maps || []).map((/** @type {any} */ item) => String(item._id).slice(0, 64)), matchups: (row?.matchups || []).map((/** @type {any} */ item) => String(item._id)) };
}

module.exports = { readArchiveOverview, _internals: { cachedFacets, FACET_TTL_MS, FACET_CACHE_MAX } };
