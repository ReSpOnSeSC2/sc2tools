"use strict";

const { buildScoutingBrief } = require("./agentScouting");

const ACTIVE = new Set(["match_loading", "match_started", "match_in_progress"]);
const RACES = new Set(["Protoss", "Terran", "Zerg"]);
const MAX_MATCH_AGE_MS = 90_000;

/** @param {unknown} value @param {number} limit @returns {string} */
function titleText(value, limit) {
  if (typeof value !== "string") return "";
  const clean = value.trim();
  return clean && clean.length <= limit && !/[\u0000-\u001f\u007f<>]/.test(clean) ? clean : "";
}

/** Only current, uniquely identified human 1v1 games can enter public titles.
 * This is a small projection of the already-enriched owner snapshot, never
 * a lookup or a copy of its private scouting/notes payload.
 * @param {Record<string, any>|null|undefined} envelope
 * @param {number} [now]
 */
function streamTitleMatch(envelope, now = Date.now()) {
  if (!envelope || !ACTIVE.has(envelope.phase) || envelope.isReplay || envelope.isObserver) return null;
  const received = envelope.receivedAt;
  if (typeof received !== "number" || !Number.isFinite(received)
    || now - received > MAX_MATCH_AGE_MS || received - now > 5000) return null;
  const gameKey = titleText(envelope.gameKey, 300);
  const opponent = titleText(envelope.opponent?.name, 120);
  const ownName = titleText(envelope.user?.name, 120);
  const players = envelope.players;
  if (!gameKey || gameKey !== envelope.gameKey || !opponent || !ownName
    || ownName.toLowerCase() === opponent.toLowerCase()
    || !Array.isArray(players) || players.length !== 2
    || players.some(player => !player || player.type !== "user"
      || typeof player.result === "string" && player.result && player.result !== "Undecided")) return null;
  const matches = (/** @type {string} */ name) => players.filter(player => titleText(player.name, 120).toLowerCase() === name.toLowerCase());
  const mine = matches(ownName), theirs = matches(opponent);
  if (mine.length !== 1 || theirs.length !== 1) return null;
  if (Number.isInteger(mine[0].team_id) && Number.isInteger(theirs[0].team_id)
    && mine[0].team_id === theirs[0].team_id) return null;
  const history = envelope.streamerHistory;
  const directToon = envelope.opponent?.toonHandle;
  const historyToon = history?.opponentPulseId;
  const mismatchedToon = typeof directToon === "string" && typeof historyToon === "string" && directToon !== historyToon;
  const brief = buildScoutingBrief(mismatchedToon ? {
    ...envelope, streamerHistory: { ...history, opponentIdentityMatched: false },
  } : envelope);
  const revealed = titleText(envelope.opponent?.revealedName, 120) || titleText(brief?.oppRevealedName, 120);
  const alias = revealed.toLowerCase() === opponent.toLowerCase() ? "" : revealed;
  const map = titleText(envelope.map, 160);
  const race = RACES.has(envelope.user?.race) ? envelope.user.race : null;
  return { gameKey, opponent, alias,
    ...(map ? { map } : {}), ...(race ? { race } : {}),
    ...(brief?.h2h ? { h2h: { wins: brief.h2h.w, losses: brief.h2h.l } } : {}) };
}

module.exports = { streamTitleMatch };
