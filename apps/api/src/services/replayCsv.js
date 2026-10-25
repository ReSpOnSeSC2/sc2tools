"use strict";
const columns = require("../config/replayExportColumns.json");
const { LIMITS } = require("../config/constants");
const { buildReplayLibraryMatch } = require("./replayLibrary");
const { ladderRegionFromToonHandle } = require("../util/regionFromToonHandle");

const PROJECTION = Object.freeze({ _id: 0, gameId: 1, date: 1, result: 1, myRace: 1, myBuild: 1,
  map: 1, durationSec: 1, macroScore: 1, apm: 1, spq: 1, myMmr: 1, myToonHandle: 1,
  "opponent.displayName": 1, "opponent.race": 1, "opponent.mmr": 1, "opponent.leagueId": 1,
  "opponent.strategy": 1, "opponent.pulseId": 1,
});

/** Numeric cells remain numbers; strings cannot become spreadsheet formulas,
 * including formulas hidden behind leading whitespace or control characters.
 * @param {unknown} value */
function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : String(value);
  if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = `'${text}`;
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** @param {unknown} raw */
function race(raw) { const value = typeof raw === "string" ? raw.trim().charAt(0).toUpperCase() : ""; return /^[PTZR]$/.test(value) ? value : ""; }

/** @param {Record<string,any>} game @returns {Record<string,any>} */
function exportRow(game) {
  const opponent = game.opponent || {};
  const myRace = race(game.myRace), oppRace = race(opponent.race);
  return { ...game, date: game.date instanceof Date ? game.date.toISOString() : game.date,
    opponent: opponent.displayName, oppRace: opponent.race, oppMmr: opponent.mmr,
    oppLeague: opponent.leagueId, oppStrategy: opponent.strategy, oppPulseId: opponent.pulseId,
    matchup: myRace && oppRace ? `${myRace}v${oppRace}` : "",
    region: ladderRegionFromToonHandle(game.myToonHandle) || "",
    effectiveBuild: game.myBuild,
    gameUrl: typeof game.gameId === "string" ? `https://sc2tools.com/app/game/${encodeURIComponent(game.gameId)}` : "",
  };
}

/** @param {unknown} raw */
function exportLimit(raw) {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? Math.min(raw, LIMITS.CSV_EXPORT_MAX_ROWS) : LIMITS.CSV_EXPORT_MAX_ROWS;
}

/** @param {import('mongodb').Collection} games @param {Record<string,any>} match @param {{signal?:AbortSignal,sort?:unknown,maxRows?:number}} [opts] */
async function* streamRows(games, match, opts = {}) {
  yield `\uFEFF${columns.map(column => column.key).join(",")}\r\n`;
  const cursor = games.find(match, { projection: PROJECTION, maxTimeMS: 30_000, ...(opts.signal ? { signal: opts.signal } : {}) })
    .sort(opts.sort === "date_asc" ? { date: 1, _id: 1 } : { date: -1, _id: -1 }).limit(exportLimit(opts.maxRows)).batchSize(100);
  try {
    for await (const game of cursor) {
      opts.signal?.throwIfAborted();
      const row = exportRow(game);
      yield `${columns.map(column => csvCell(row[column.key])).join(",")}\r\n`;
    }
  } finally { await cursor.close(); }
}

/** A bounded metadata-only sentinel establishes the HTTP truncation header
 * before streaming starts. No replay payloads or complete arrays are loaded.
 * @param {import('mongodb').Collection} games @param {string} userId @param {object} filters
 * `trustedMatch` is constructed by an owned service, never copied from query
 * JSON. It can only narrow the existing owner/visibility/global scope.
 * @param {{search?:unknown,result?:unknown,matchup?:unknown,sort?:unknown,signal?:AbortSignal,maxRows?:number,trustedMatch?:Record<string,any>}} [opts] */
async function prepareReplayCsv(games, userId, filters, opts = {}) {
  const libraryMatch = buildReplayLibraryMatch(userId, { filters, search: opts.search, result: opts.result, matchup: opts.matchup, view: "owner" });
  const match = opts.trustedMatch ? { $and: [libraryMatch, opts.trustedMatch] } : libraryMatch;
  const sentinel = await games.find(match, { projection: { _id: 1 }, maxTimeMS: 5000, ...(opts.signal ? { signal: opts.signal } : {}) })
    .sort(opts.sort === "date_asc" ? { date: 1, _id: 1 } : { date: -1, _id: -1 }).skip(exportLimit(opts.maxRows)).limit(1).toArray();
  return { truncated: sentinel.length > 0, stream: streamRows(games, match, opts) };
}

/** @param {import('mongodb').Collection} games @param {string} userId @param {object} filters */
function streamReplayCsv(games, userId, filters) {
  return streamRows(games, buildReplayLibraryMatch(userId, { filters, view: "owner" }));
}
module.exports = { prepareReplayCsv, streamReplayCsv, csvCell, PROJECTION };
