"use strict";

const { createHash } = require("crypto");
const { parseAccounts } = require("../util/accountFilter");
const { resultBucket } = require("../util/parseQuery");
const { isStatsGame } = require("../util/gameVisibility");

const FORMATS = Object.freeze([1, 3, 5, 7]);
const MAX_SERIES_GAMES = 80;
const MAX_SERIES_MAPS = 20;
const STATUSES = ["active", "complete", "ended", "paused"];
/** @param {unknown} value */
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @param {number} maximum */
function text(value, maximum) {
  return typeof value === "string" && value.length <= maximum
    && !/[<>\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) ? value.trim() : "";
}
/** @param {unknown} value */
function toon(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return parseAccounts([value])?.[0] ?? null; } catch { return null; }
}
/** @param {unknown} value */
function race(value) {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  const names = /** @type {Record<string,string>} */ ({ p: "P", protoss: "P", t: "T", terran: "T", z: "Z", zerg: "Z", r: "R", random: "R" });
  return names[key] ?? null;
}
/** @param {unknown} value */
function timestamp(value) {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(at) && at > 0 ? at : null;
}
/** @param {number} status @param {string} code */
const fail = (status, code) => Object.assign(new Error(code), { status, code });

/** @typedef {{receipt:string, startedAt:number, endedAt:number, result:'win'|'loss'|'draw', map:string|null}} SeriesGame */
/** @typedef {{v:1, key:string, revision:number, format:number, opponentName:string, opponentToon:string|null,
 * maps:string[], score:{you:number,opponent:number}, games:SeriesGame[], status:string, startedAt:number,
 * updatedAt:number, playerRace:string|null, opponentRace:string|null, completionNotified:boolean}} StreamSeries */

/** Start is an explicit user action. Invalid bounded inputs never become a
 * partially accepted series. Receipts and identity stay server-only.
 * @param {unknown} raw @param {number} now @param {string} key @param {number} revision
 * @returns {StreamSeries} */
function startSeries(raw, now, key, revision) {
  if (!object(raw)) throw fail(400, "invalid_series");
  const body = /** @type {Record<string,any>} */ (raw);
  if (Object.keys(body).some(k => !["action", "revision", "format", "opponentName", "opponentToon", "maps"].includes(k))
    || !FORMATS.includes(body.format) || !text(body.opponentName, 80)
    || body.opponentToon !== undefined && body.opponentToon !== null && !toon(body.opponentToon)
    || body.maps !== undefined && (!Array.isArray(body.maps) || body.maps.length > MAX_SERIES_MAPS
      || body.maps.some((/** @type {unknown} */ value) => !text(value, 100)))) throw fail(400, "invalid_series");
  return { v: 1, key, revision, format: body.format, opponentName: text(body.opponentName, 80),
    opponentToon: toon(body.opponentToon), maps: (body.maps ?? []).map((/** @type {unknown} */ value) => text(value, 100)),
    score: { you: 0, opponent: 0 }, games: [], status: "active", startedAt: now, updatedAt: now,
    playerRace: null, opponentRace: null, completionNotified: false };
}

/** Strict read boundary for the new bounded subdocument. Other Studio fields
 * are never copied into the series transport. @param {unknown} raw @returns {StreamSeries|null} */
function readSeries(raw) {
  if (!object(raw)) return null;
  const row = /** @type {StreamSeries} */ (raw);
  if (row.v !== 1 || !text(row.key, 100) || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !FORMATS.includes(row.format) || !text(row.opponentName, 80) || !STATUSES.includes(row.status)
    || !Number.isFinite(row.startedAt) || row.startedAt <= 0 || !Number.isFinite(row.updatedAt)
    || !object(row.score) || !Array.isArray(row.maps) || row.maps.length > MAX_SERIES_MAPS
    || row.maps.some(value => !text(value, 100)) || !Array.isArray(row.games) || row.games.length > MAX_SERIES_GAMES) return null;
  const needed = Math.ceil(row.format / 2);
  if (![row.score.you, row.score.opponent].every(n => Number.isInteger(n) && n >= 0 && n <= needed)
    || row.score.you === needed && row.score.opponent === needed
    || row.opponentToon !== null && !toon(row.opponentToon)) return null;
  const winner = Math.max(row.score.you, row.score.opponent) === needed;
  if (row.status === "complete" && !winner || row.status === "active" && winner
    || row.status === "paused" && (winner || row.games.length < MAX_SERIES_GAMES)) return null;
  const games = row.games.filter(g => object(g) && /^[a-f0-9]{64}$/u.test(g.receipt)
    && ["win", "loss", "draw"].includes(g.result) && Number.isFinite(g.startedAt) && Number.isFinite(g.endedAt)
    && g.startedAt > row.startedAt && g.endedAt >= g.startedAt && (g.map === null || !!text(g.map, 100)));
  if (games.length !== row.games.length || new Set(games.map(g => g.receipt)).size !== games.length) return null;
  return { v: 1, key: row.key, revision: row.revision, format: row.format, opponentName: row.opponentName,
    opponentToon: toon(row.opponentToon), maps: [...row.maps], score: { ...row.score }, games: games.map(g => ({ ...g })),
    status: row.status, startedAt: row.startedAt, updatedAt: row.updatedAt,
    playerRace: race(row.playerRace), opponentRace: race(row.opponentRace), completionNotified: row.completionNotified === true };
}

/** A known toon mismatch must never fall through to a same-name opponent.
 * A name-only start pins its identity once a matching replay supplies a toon.
 * @param {StreamSeries} series @param {Record<string,any>} game */
function matchesSeriesOpponent(series, game) {
  const theirs = toon(game.opponent?.toonHandle);
  if (series.opponentToon && theirs) return series.opponentToon === theirs;
  const name = text(game.opponent?.displayName, 80);
  return !!name && name.toLowerCase() === series.opponentName.toLowerCase();
}

/** Exact start is already supplied by replay.start_time through CloudGame.
 * date is replay END; durationSec is game-clock length, not a reliable wall
 * clock interval at arbitrary game speeds. Missing starts need manual scoring.
 * @param {StreamSeries} series @param {Record<string,any>} game @param {number} now
 * @returns {StreamSeries|null} */
function scoreSeriesGame(series, game, now) {
  if (series.status !== "active" || !isStatsGame(game) || game.isTest === true || game.isResumedFromReplay === true
    || !matchesSeriesOpponent(series, game)) return null;
  const startedAt = timestamp(game.startedAt), endedAt = timestamp(game.date);
  const gameId = typeof game.gameId === "string" && game.gameId.length <= 128 ? game.gameId : "";
  const result = resultBucket(game.result) ?? (["tie", "draw"].includes(String(game.result).toLowerCase()) ? "draw" : null);
  if (!gameId || !result || startedAt === null || endedAt === null || startedAt <= series.startedAt
    || endedAt < startedAt || endedAt > now + 60_000) return null;
  const receipt = createHash("sha256").update(gameId).digest("hex");
  if (series.games.some(g => g.receipt === receipt)) return null;
  if (series.games.length >= MAX_SERIES_GAMES) return { ...series, revision: series.revision + 1, status: "paused", updatedAt: now };
  const score = { ...series.score };
  if (result === "win") score.you++; else if (result === "loss") score.opponent++;
  const games = /** @type {SeriesGame[]} */ ([...series.games, { receipt, startedAt, endedAt, result, map: text(game.map, 100) || null }]);
  const complete = Math.max(score.you, score.opponent) >= Math.ceil(series.format / 2);
  return { ...series, revision: series.revision + 1, score, games, updatedAt: now,
    status: complete ? "complete" : games.length >= MAX_SERIES_GAMES ? "paused" : "active",
    opponentToon: series.opponentToon ?? toon(game.opponent?.toonHandle),
    playerRace: race(game.myRace) ?? series.playerRace, opponentRace: race(game.opponent?.race) ?? series.opponentRace };
}

/** Manual corrections preserve receipts. Ended series never resume implicitly.
 * @param {StreamSeries} series @param {Record<string,any>} body @param {number} now
 * @returns {StreamSeries} */
function editSeries(series, body, now) {
  const allowed = body.action === "end" ? ["action", "revision"] : ["action", "revision", "side", "delta"];
  if (Object.keys(body).some(k => !allowed.includes(k)) || !["end", "adjust"].includes(body.action)) throw fail(400, "invalid_series_action");
  if (body.revision !== series.revision) throw fail(409, "series_changed");
  if (body.action === "end") return { ...series, status: "ended", revision: series.revision + 1, updatedAt: now };
  if (series.status === "ended") throw fail(409, "series_ended");
  if (!["you", "opponent"].includes(body.side) || ![-1, 1].includes(body.delta)) throw fail(400, "invalid_series_action");
  const needed = Math.ceil(series.format / 2);
  const score = { ...series.score, [body.side]: Math.max(0, Math.min(needed, series.score[/** @type {'you'|'opponent'} */ (body.side)] + body.delta)) };
  if (score.you === needed && score.opponent === needed) throw fail(409, "series_already_decided");
  const complete = Math.max(score.you, score.opponent) === needed;
  return { ...series, score, revision: series.revision + 1, updatedAt: now,
    status: complete ? "complete" : series.games.length >= MAX_SERIES_GAMES ? "paused" : "active" };
}

/** Public token transport contains no private identity, game IDs, receipts or
 * replay URLs. H2H is attached separately from an exact-identity local cache.
 * @param {StreamSeries|null} series */
function publicSeries(series) {
  if (!series) return null;
  const index = series.status === "active" || series.status === "paused" ? series.games.length : Math.max(0, series.games.length - 1);
  return { v: 1, revision: series.revision, format: series.format, opponentName: series.opponentName,
    maps: series.maps, score: series.score, status: series.status, startedAt: series.startedAt,
    playerRace: series.playerRace, opponentRace: series.opponentRace, gamesPlayed: series.games.length,
    currentMap: series.maps[index] ?? null, nextMap: series.maps[index + 1] ?? null,
    games: series.games.map(({ result, map }) => ({ result, map })) };
}

module.exports = { FORMATS, MAX_SERIES_GAMES, MAX_SERIES_MAPS, toon, timestamp, startSeries, readSeries,
  matchesSeriesOpponent, scoreSeriesGame, editSeries, publicSeries, seriesError: fail };
