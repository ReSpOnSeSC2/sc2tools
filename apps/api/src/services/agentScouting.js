"use strict";

// This projection contains private notes. It belongs only in the authenticated
// device room or the device-auth REST response, never an overlay event.
const SCOUTING_BRIEF_MAX_BYTES = 8_192;
const ACTIVE = new Set(["match_loading", "match_started", "match_in_progress"]);

/** @param {unknown} value @param {number} limit @returns {string} */
function text(value, limit) {
  return typeof value === "string"
    ? value.trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/, "")
    : "";
}
/** @param {unknown} value @returns {number|null} */
function count(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000_000) : null;
}
/** @param {unknown} value @returns {number|null} */
function share(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value : null;
}
/** @param {unknown} value @returns {string|null} */
function timestamp(value) {
  const raw = text(value, 40);
  const time = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * Bounded plain-data view of the already-computed current enrichment. No I/O.
 * pulseId is included only for the exact live toon, so the post-game note can
 * use the same identity as the dossier without guessing from a display name.
 * @param {Record<string, any>|null|undefined} envelope
 * @returns {Record<string, any>|null}
 */
function buildScoutingBrief(envelope) {
  if (!envelope || !ACTIVE.has(envelope.phase) || envelope.isReplay) return null;
  const gameKey = text(envelope.gameKey, 300);
  if (!gameKey || gameKey !== envelope.gameKey) return null;
  const history = envelope.streamerHistory;
  if (!history || typeof history !== "object" || Array.isArray(history)) return null;
  const oppName = text(envelope.opponent?.name, 120);
  if (!oppName) return null;
  const historyName = text(history.oppName, 120);
  if (historyName && historyName.toLowerCase() !== oppName.toLowerCase()) return null;
  const rawPulse = text(envelope.opponent?.toonHandle, 80);
  const pulseId = /^\d+-\d+-\d+-\d+$/.test(rawPulse) ? rawPulse : null;
  // Legacy display-name matches can be a different barcode account. Keep
  // those records out of this private card, while exact-toon notes remain safe.
  const records = history.opponentIdentityMatched === false ? {} : history;
  /** @type {any[]} */
  const recent = Array.isArray(records.recentGames) ? records.recentGames : [];
  const last3 = recent
    .slice(0, 3).filter((row) => row && typeof row === "object")
    .map((row) => ({
      result: ["Win", "Loss", "Tie"].includes(row.result) ? row.result : null,
      map: text(row.map, 120), oppBuild: text(row.oppBuild, 160),
      at: timestamp(row.date),
    }));
  const wins = count(records.headToHead?.wins);
  const losses = count(records.headToHead?.losses);
  const favorite = records.favOpening;
  const opening = text(favorite?.name, 160);
  const samples = count(favorite?.samples);
  const n = count(favorite?.of);
  const openingShare = share(favorite?.share);
  const answer = records.bestAnswer;
  const build = text(answer?.build, 160);
  const total = count(answer?.total);
  const winRate = share(answer?.winRate);
  const answerWins = total !== null && winRate !== null ? Math.round(total * winRate) : null;
  const brief = {
    gameKey, oppName, pulseId,
    h2h: wins !== null && losses !== null ? { w: wins, l: losses } : null,
    lastMet: last3[0]?.at ? { at: last3[0].at, result: last3[0].result, map: last3[0].map } : null,
    last3,
    forecast: opening && samples !== null && n !== null && samples <= n && openingShare !== null
      ? { name: opening, share: openingShare, samples, n } : null,
    bestAnswer: build && total !== null && answerWins !== null
      ? { build, w: answerWins, l: total - answerWins } : null,
    cheese: share(records.cheeseProbability),
    note: text(history.opponentNotes?.text, 500),
    dossierUrl: pulseId ? `/app/opponents/${encodeURIComponent(pulseId)}` : "/app/opponents",
  };
  return Buffer.byteLength(JSON.stringify(brief), "utf8") <= SCOUTING_BRIEF_MAX_BYTES ? brief : null;
}

/** @param {string} userId */
const scoutingDeviceRoom = (userId) => `device-user:${userId}`;
module.exports = { buildScoutingBrief, scoutingDeviceRoom, SCOUTING_BRIEF_MAX_BYTES };
