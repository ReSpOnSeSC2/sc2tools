"use strict";

// This projection contains private notes. It belongs only in the authenticated
// device room or the device-auth REST response, never an overlay event.
const SCOUTING_BRIEF_MAX_BYTES = 8_192;
const ACTIVE = new Set(["match_loading", "match_started", "match_in_progress"]);
const { RECENT_BUILDS_LIMIT } = require("./scouting/recentBuilds");
/** The strip elides long names anyway; the dossier keeps the full one. */
const BRIEF_BUILD_NAME_LIMIT = 80;

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
/** @param {unknown} value @returns {string|null} */
function toonIdentity(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length <= 80 && /^\d+-S2-\d+-\d+$/.test(id) ? id : null;
}
/** @param {unknown} value @returns {'Win'|'Loss'|'Tie'|null} */
function gameResult(value) {
  return value === "Win" || value === "Loss" || value === "Tie" ? value : null;
}

/**
 * One player's recent builds in the strip's short form: the result and the
 * build only, so ten rows stay a small part of the byte cap.
 * @param {unknown} rows
 */
function briefBuildRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .slice(0, RECENT_BUILDS_LIMIT)
    .filter((row) => row && typeof row === "object")
    .map((row) => ({ result: gameResult(row.result), build: text(row.build, BRIEF_BUILD_NAME_LIMIT) }));
}
/**
 * The lists are matched by exact account, never by display name, so they
 * are read from the enrichment even when a name-only match set its other
 * records aside.
 * @param {unknown} value ``streamerHistory.recentBuilds``
 * @returns {{matchup: string|null, mine: object[], theirs: object[]|null}|null}
 *   null when the enrichment carries no lists, so the brief omits the field;
 *   ``theirs`` stays null while the opponent's account is unknown
 */
function briefRecentBuilds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const builds = /** @type {Record<string, unknown>} */ (value);
  const { matchup } = builds;
  return {
    matchup: typeof matchup === "string" && /^[PTZR]v[PTZR]$/.test(matchup) ? matchup : null,
    mine: briefBuildRows(builds.mine),
    theirs: Array.isArray(builds.theirs) ? briefBuildRows(builds.theirs) : null,
  };
}
/** @param {object} brief @returns {boolean} */
function fitsBrief(brief) {
  return Buffer.byteLength(JSON.stringify(brief), "utf8") <= SCOUTING_BRIEF_MAX_BYTES;
}
/**
 * The largest brief inside the byte cap. The recent builds are dropped
 * first, so adding them can never cost a player the lines an older agent
 * already showed.
 * @param {Record<string, any>} brief
 * @param {object|null} recentBuilds
 * @returns {Record<string, any>|null}
 */
function cappedBrief(brief, recentBuilds) {
  const complete = recentBuilds ? { ...brief, recentBuilds } : brief;
  if (fitsBrief(complete)) return complete;
  return fitsBrief(brief) ? brief : null;
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
  const ownToon = toonIdentity(envelope.opponent?.toonHandle);
  const resolvedToon = history.opponentIdentityMatched === true ? toonIdentity(history.opponentPulseId) : null;
  const pulseId = ownToon || resolvedToon;
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
  const posterior = records.openingForecast && typeof records.openingForecast === "object" ? records.openingForecast : null;
  const favorite = posterior ? posterior.top?.[0] : records.favOpening;
  const opening = text(favorite?.name, 160);
  const samples = count(favorite?.samples);
  const n = count(posterior ? posterior.sampleSize : favorite?.of);
  const openingShare = share(posterior ? favorite?.probability : favorite?.share);
  const confidence = ["Low", "Medium", "High"].includes(posterior?.confidence) ? posterior.confidence : null;
  const effectiveN = typeof posterior?.effectiveN === "number" && Number.isFinite(posterior.effectiveN) && posterior.effectiveN >= 0 && posterior.effectiveN <= 75 ? posterior.effectiveN : null;
  const answer = records.bestAnswer;
  const build = text(answer?.build, 160);
  const total = count(answer?.total);
  const winRate = share(answer?.winRate);
  const answerWins = total !== null && winRate !== null ? Math.round(total * winRate) : null;
  const brief = {
    gameKey, oppName, pulseId,
    oppRevealedName: text(envelope.opponent?.revealedName, 120) || text(records.oppRevealedName, 120) || null,
    h2h: wins !== null && losses !== null ? { w: wins, l: losses } : null,
    lastMet: last3[0]?.at ? { at: last3[0].at, result: last3[0].result, map: last3[0].map } : null,
    last3,
    forecast: opening && samples !== null && n !== null && samples <= n && openingShare !== null
      && (!posterior || (confidence && effectiveN !== null))
      ? { name: opening, share: openingShare, samples, n, ...(posterior ? { method: "posterior", confidence, effectiveN } : {}) } : null,
    alsoPlaysAs: Array.isArray(records.alsoPlaysAs) ? [...new Set(records.alsoPlaysAs.slice(0, 19).map((/** @type {unknown} */ value) => text(value, 120)).filter(Boolean))].slice(0, 3) : [],
    bestAnswer: build && total !== null && answerWins !== null
      ? { build, w: answerWins, l: total - answerWins } : null,
    cheese: share(records.cheeseProbability),
    note: pulseId ? text(history.opponentNotes?.text, 500) : "",
    dossierUrl: pulseId ? `/app/opponents/${encodeURIComponent(pulseId)}` : "/app/opponents",
  };
  return cappedBrief(brief, briefRecentBuilds(history.recentBuilds));
}

/**
 * The envelope as an overlay token receives it. Each player's recent
 * builds are for the device's private views, so the OBS source gets
 * exactly the enrichment it got before they existed.
 * @template {Record<string, any>|null|undefined} T
 * @param {T} envelope
 * @returns {T}
 */
function overlayEnvelope(envelope) {
  const history = envelope?.streamerHistory;
  if (!history || typeof history !== "object" || !("recentBuilds" in history)) return envelope;
  const shared = { ...history };
  delete shared.recentBuilds;
  return /** @type {T} */ ({ ...envelope, streamerHistory: shared });
}

/** @param {string} userId */
const scoutingDeviceRoom = (userId) => `device-user:${userId}`;
module.exports = { buildScoutingBrief, overlayEnvelope, scoutingDeviceRoom, SCOUTING_BRIEF_MAX_BYTES };
