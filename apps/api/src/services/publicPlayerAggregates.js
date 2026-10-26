"use strict";
const { STATS_GAME_MATCH } = require("../util/gameVisibility");
const { safeIso } = require("../util/publicPlayerConfig");
const { publicVerification } = require("./reviewerReputation");
const RESULT = { $toLower: { $ifNull: ["$result", ""] } };
const WIN = { $in: [RESULT, ["win", "victory"]] };
const LOSS = { $in: [RESULT, ["loss", "defeat"]] };
const VALID_MMR = { $and: [{ $isNumber: "$myMmr" }, { $gte: ["$myMmr", 500] }, { $lte: ["$myMmr", 9999] }] };
const count = (/** @type {unknown} */ value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;

/** This is the complete public recent-game allowlist. Never spread a row.
 * @param {unknown} raw */
function recentForm(raw) {
  if (!Array.isArray(raw)) return { recentForm: [], currentStreak: null, lastPlayedAt: null };
  const source = raw.slice(0, 20);
  const rows = source.flatMap(row => {
    const result = resultLetter(row?.result), date = safeIso(row?.date);
    const mine = raceLetter(row?.my_race), theirs = raceLetter(row?.opp_race);
    return result && date && mine && theirs ? [{ result, matchup: `${mine}v${theirs}`, date }] : [];
  });
  let streak = 0;
  const kind = resultLetter(source[0]?.result);
  if (kind === "W" || kind === "L") for (const row of source) {
    if (resultLetter(row?.result) !== kind || !safeIso(row?.date) || !raceLetter(row?.my_race) || !raceLetter(row?.opp_race)) break;
    streak += 1;
  }
  return { recentForm: rows, currentStreak: streak ? { kind, count: streak } : null, lastPlayedAt: safeIso(source[0]?.date) };
}

/** One opt-in, user-indexed aggregate; bounded groups and maxTimeMS.
 * It reads ordinary slim fields only, never replay blobs or other owners.
 * @param {any} db @param {string} userId @param {any} settings @param {Date} now @param {Array<{number:number,start:Date,end:Date}>} [seasonWindows] */
async function extraAggregates(db, userId, settings, now, seasonWindows = []) {
  /** @type {Record<string,any[]>} */ const facets = {};
  if (settings.showMmrHistory) facets.mmr = [
    { $match: { date: { $gte: new Date(now.getTime() - 90 * 86_400_000) }, myMmr: { $gte: 500, $lte: 9999 } } },
    { $group: { _id: { $dateTrunc: { date: "$date", unit: "week", timezone: "UTC", startOfWeek: "monday" } }, mmr: { $avg: "$myMmr" }, games: { $sum: 1 } } },
    { $sort: { _id: 1 } }, { $limit: 14 },
  ];
  if (settings.showMaps) facets.maps = [
    { $match: { map: { $type: "string", $ne: "" } } },
    { $group: { _id: "$map", games: { $sum: 1 }, wins: { $sum: { $cond: [WIN, 1, 0] } }, losses: { $sum: { $cond: [LOSS, 1, 0] } } } },
    { $match: { games: { $gte: 10 } } }, { $sort: { games: -1, _id: 1 } }, { $limit: 20 },
  ];
  if (settings.showSeasons && seasonWindows.length) facets.seasons = [
    { $match: { date: { $gte: seasonWindows[seasonWindows.length - 1].start, $lt: seasonWindows[0].end } } },
    { $set: { _publicSeason: { $switch: { branches: seasonWindows.map(window => ({ case: { $and: [{ $gte: ["$date", window.start] }, { $lt: ["$date", window.end] }] }, then: window.number })), default: null } } } },
    { $match: { _publicSeason: { $ne: null } } },
    { $group: { _id: { season: "$_publicSeason", race: "$myRace" }, games: { $sum: 1 }, wins: { $sum: { $cond: [WIN, 1, 0] } }, losses: { $sum: { $cond: [LOSS, 1, 0] } }, peak: { $max: { $cond: [VALID_MMR, "$myMmr", null] } } } },
    { $sort: { "_id.season": -1, games: -1 } },
    { $group: { _id: "$_id.season", games: { $sum: "$games" }, wins: { $sum: "$wins" }, losses: { $sum: "$losses" }, peak: { $max: "$peak" }, mainRace: { $first: "$_id.race" } } },
    { $sort: { _id: -1 } }, { $limit: 12 },
  ];
  if (!Object.keys(facets).length) return settings.showSeasons ? { seasons: [], seasonDataAvailable: false } : {};
  const [result] = await db.games.aggregate([{ $match: { userId, ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true } } }, { $facet: facets }], { maxTimeMS: 3000 }).toArray();
  /** @type {Record<string,any>} */ const out = {};
  if (settings.showMmrHistory) out.mmrHistory = (result?.mmr || []).flatMap((/** @type {any} */ row) => { const date = safeIso(row._id); return date && Number.isFinite(row.mmr) ? [{ date, mmr: Math.round(row.mmr), games: count(row.games) }] : []; });
  if (settings.showMaps) out.maps = (result?.maps || []).filter((/** @type {any} */ row) => typeof row._id === "string").map((/** @type {any} */ row) => ({ name: row._id.slice(0, 100), games: count(row.games), wins: count(row.wins), losses: count(row.losses) }));
  if (settings.showSeasons) out.seasons = (result?.seasons || []).filter((/** @type {any} */ row) => Number.isSafeInteger(row._id)).map((/** @type {any} */ row) => ({ season: row._id, games: count(row.games), wins: count(row.wins), losses: count(row.losses), peakMmr: Number.isFinite(row.peak) && row.peak >= 500 && row.peak <= 9999 ? Math.round(row.peak) : null, mainRace: raceLetter(row.mainRace) }));
  if (settings.showSeasons) out.seasonDataAvailable = seasonWindows.length > 0;
  return out;
}

/** @param {unknown} value */
function resultLetter(value) { const result = typeof value === "string" ? value.toLowerCase() : ""; return ["win", "victory"].includes(result) ? "W" : ["loss", "defeat"].includes(result) ? "L" : ["tie", "draw"].includes(result) ? "T" : null; }
/** @param {unknown} value */
function raceLetter(value) { const letter = typeof value === "string" ? value[0]?.toUpperCase() : ""; return letter && "PTZR".includes(letter) ? letter : null; }

/** The reviewer service is already public; keep an explicit second boundary
 * so future private service fields cannot silently join player profiles.
 * @param {any} raw */
function publicReviewer(raw) {
  if (!raw || typeof raw !== "object") return null;
  return { karma: typeof raw.karma === "number" && Number.isFinite(raw.karma) ? Math.trunc(raw.karma) : 0,
    reviews: count(raw.reviews), helpful: count(raw.helpful), bestAnswers: count(raw.bestAnswers),
    badges: Array.isArray(raw.badges) ? raw.badges.slice(0, 12).filter((/** @type {any} */ row) => typeof row?.key === "string" && typeof row.label === "string").map((/** @type {any} */ row) => ({ key: row.key.slice(0, 80), label: row.label.slice(0, 80) })) : [],
    flair: typeof raw.flair === "string" ? raw.flair.slice(0, 80) : null,
    verified: publicVerification(raw.verified),
    matchupsReviewed: Array.isArray(raw.matchupsReviewed) ? raw.matchupsReviewed.slice(0, 16).filter((/** @type {any} */ row) => typeof row?.matchup === "string" && /^[PTZR]v[PTZR]$/.test(row.matchup)).map((/** @type {any} */ row) => ({ matchup: row.matchup, count: count(row.count) })) : [],
    ...(raw.matchupsSampled === true ? { matchupsSampled: true, matchupsSampleLimit: 2000 } : {}),
  };
}
module.exports = { recentForm, extraAggregates, publicReviewer };
