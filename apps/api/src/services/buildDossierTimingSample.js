"use strict";

const TimingCatalog = require("./timingCatalog");
const { STATS_GAME_MATCH } = require("../util/gameVisibility");

/** One compact sequential sample feeds all timing comparisons.
 * @param {{games:import('mongodb').Collection,details?:Pick<import('./gameDetails').GameDetailsService,'findMany'>|null}} deps
 * @param {string} userId @param {Array<Record<string,any>>} sample @param {AbortSignal} [signal] */
async function hydrateDossierTimings({ games, details }, userId, sample, signal) {
  const compact = [];
  for (const game of (Array.isArray(sample) ? sample : []).slice(0, 25)) {
    checkAbort(signal);
    const gameId = String(game.gameId || "");
    /** @type {Record<string,any>} */
    let blob = {};
    if (details && gameId) {
      const one = await details.findMany(userId, [gameId], { fields: ["buildLog", "oppBuildLog"], concurrency: 1, signal });
      blob = one.get(gameId) || {};
    }
    checkAbort(signal);
    const legacy = await legacyFields(games, userId, gameId, blob, game, signal);
    checkAbort(signal);
    compact.push({ ...game,
      buildLog: compactDossierTimingLog(Array.isArray(blob.buildLog) ? blob.buildLog : legacy.buildLog),
      oppBuildLog: compactDossierTimingLog(Array.isArray(blob.oppBuildLog) ? blob.oppBuildLog : legacy.oppBuildLog),
    });
  }
  return compact;
}

/** @param {import('mongodb').Collection} games @param {string} userId @param {string} gameId
 * @param {Record<string,any>} blob @param {Record<string,any>} metadata @param {AbortSignal} [signal]
 * @returns {Promise<Record<string,any>>} */
async function legacyFields(games, userId, gameId, blob, metadata, signal) {
  if (!gameId || Array.isArray(blob.buildLog) && Array.isArray(blob.oppBuildLog)) return {};
  // Narrow legacy test doubles carry inline logs in their projected row.
  if (typeof games.findOne !== "function") return metadata;
  return await games.findOne({ userId, gameId, ...STATS_GAME_MATCH }, {
    projection: { _id: 0, buildLog: 1, oppBuildLog: 1 }, ...(signal ? { signal } : {}),
  }) || {};
}

/** @param {AbortSignal} [signal] */
function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error("Dossier request aborted"), { name: "AbortError" });
}

const TIMING_TOKENS = Object.freeze(Object.values(TimingCatalog.RACE_BUILDINGS).flat()
  .map(row => String(row.token || "").toLowerCase()).filter(Boolean));
const TIMING_LINE_RE = /^\[(\d{1,5}):([0-5]\d)\]\s+([A-Za-z0-9_]{1,64})(?=\s|$)/;

/** Preserve the existing compactor: retain one tiny line per timing-catalog
 * token, never a substring retaining a multi-megabyte legacy backing store.
 * @param {unknown} value */
function compactDossierTimingLog(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set(), out = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const match = TIMING_LINE_RE.exec(raw.slice(0, 256));
    if (!match) continue;
    const safeName = Buffer.from(match[3], "ascii").toString("ascii"), lower = safeName.toLowerCase();
    let keep = false;
    for (const token of TIMING_TOKENS) {
      if (seen.has(token) || !lower.includes(token)) continue;
      seen.add(token); keep = true;
    }
    if (keep) out.push(`[${Number(match[1])}:${String(Number(match[2])).padStart(2, "0")}] ${safeName}`);
  }
  return out;
}

module.exports = { hydrateDossierTimings, compactDossierTimingLog };
