"use strict";

/** @param {unknown} value @returns {string|null} */
function isoDate(value) {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Compact all-time metadata from the existing owner-scoped slim read.
 * Document dates describe first/last meetings; a capped game array never
 * supplies a pretend first meeting. No detail data or additional reads.
 * @param {Array<Record<string,any>>} games newest first
 * @param {Array<Record<string,any>>} identities already authorized opponent rows
 * @param {number} sourceLimit
 * @param {boolean} truncated
 */
function opponentSeries(games, identities, sourceLimit, truncated) {
  const limit = Math.max(1, Math.min(1000, Math.floor(sourceLimit) || 1000));
  const first = identities.map(row => isoDate(row.firstSeen)).filter(Boolean).sort();
  const last = identities.map(row => isoDate(row.lastSeen)).filter(Boolean).sort();
  return {
    firstSeen: first[0] || null,
    lastSeen: last[last.length - 1] || null,
    sourceLimit: limit,
    truncated: truncated || games.length > limit,
    games: games.slice(0, limit).map(game => ({
      id: typeof game.gameId === "string" && game.gameId.length <= 200 ? game.gameId : null,
      date: isoDate(game.date),
      result: typeof game.result === "string" && /^(win|loss|victory|defeat|draw|tie)$/i.test(game.result) ? game.result : null,
      map: typeof game.map === "string" ? game.map.slice(0, 200) : null,
    })),
  };
}

module.exports = { opponentSeries };
