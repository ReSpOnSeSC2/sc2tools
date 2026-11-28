"use strict";

const { buildScoutingBrief } = require("./agentScouting");
const { accountMatchHandles } = require("../util/accountFilter");
const { STATS_GAME_MATCH } = require("../util/gameVisibility");

const ACTIVE = new Set(["match_loading", "match_started", "match_in_progress"]);
const RACES = new Set(["Protoss", "Terran", "Zerg"]);
const MAX_MATCH_AGE_MS = 90_000;
const TOON = new RegExp(require("../config/accountFilter.json").handlePattern, "i");
const CHARACTER_ID = /^[1-9]\d{0,19}$/;
const COMPETITIVE = { ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true } };

/** @param {unknown} value @returns {value is string} */
const isToon = value => typeof value === "string" && TOON.test(value);
/** @param {unknown} value @returns {value is string} */
const isCharacterId = value => typeof value === "string" && CHARACTER_ID.test(value);

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
  const opponentRace = RACES.has(theirs[0].race) ? theirs[0].race : null;
  return { gameKey, opponent, alias,
    ...(map ? { map } : {}), ...(race ? { race } : {}), ...(opponentRace ? { opponentRace } : {}),
    ...(brief?.h2h ? { h2h: { wins: brief.h2h.w, losses: brief.h2h.l } } : {}) };
}

/** Read the exact synced replay and count eligible games for its confirmed opponent.
 * The replay collection includes the just-synced result even if the advisory
 * opponent counters or live cache lag behind the upload receipt.
 * @param {Pick<import('../db/connect').DbContext, 'games'|'opponents'>} db
 * @param {string} userId
 * @param {string} gameId
 * @param {import('./scoutingIdentities').ScoutingIdentitiesService} [scoutingIdentities]
 */
async function streamTitleCompletedMatch(db, userId, gameId, scoutingIdentities) {
  const game = await db.games.findOne({ userId, gameId, ...COMPETITIVE }, { maxTimeMS: 1000,
    projection: { _id: 0, "opponent.displayName": 1, "opponent.toonHandle": 1, "opponent.pulseId": 1,
      "opponent.pulseCharacterId": 1, map: 1, myRace: 1, matchFormat: 1, playerCount: 1 } });
  const opponent = titleText(game?.opponent?.displayName, 120);
  if (!game || !opponent || (game.matchFormat != null && game.matchFormat !== "1v1")
    || (game.playerCount != null && game.playerCount !== 2)) return null;
  const map = titleText(game.map, 160);
  const match = { gameKey: gameId, opponent, alias: "", ...(map ? { map } : {}),
    ...(RACES.has(game.myRace) ? { race: game.myRace } : {}) };
  const toon = [game.opponent.toonHandle, game.opponent.pulseId].find(isToon);
  const storedCharacterId = [game.opponent.pulseCharacterId, game.opponent.pulseId].find(isCharacterId);
  if (!toon && !storedCharacterId) return match;
  const handles = toon ? accountMatchHandles([toon]) : [];
  const identityFilter = toon ? { pulseId: { $in: handles } }
    : { $or: [{ pulseCharacterId: storedCharacterId }, { pulseId: storedCharacterId }] };
  const identity = await db.opponents.findOne({ userId, ...identityFilter }, { maxTimeMS: 1000,
    projection: { _id: 0, pulseId: 1, pulseCharacterId: 1, toonHandle: 1, revealedName: 1 } }).catch(() => null);
  const revealed = titleText(identity?.revealedName, 120);
  if (revealed.toLowerCase() !== opponent.toLowerCase()) match.alias = revealed;
  const linked = identity && scoutingIdentities ? await scoutingIdentities.resolve(userId, identity).catch(() => null) : null;
  const linkedToons = [toon, ...(linked?.pulseIds || [])].filter(isToon);
  const opponentToons = [...new Set(linkedToons.map(handle => handle.toUpperCase()))].slice(0, 20);
  const opponentHandles = opponentToons.length ? accountMatchHandles(opponentToons) || [] : [];
  const characterIds = [...new Set([storedCharacterId || identity?.pulseCharacterId, ...(linked?.characterIds || [])]
    .filter(isCharacterId))].slice(0, 20);
  /** @type {import('mongodb').Document[]} */
  const replayMatches = [{ "opponent.pulseId": { $in: [...opponentHandles, ...characterIds] } }, { gameId }];
  if (characterIds.length) replayMatches.push({ "opponent.pulseCharacterId": { $in: characterIds } });
  const [counts] = await db.games.aggregate([
    { $match: { userId, ...COMPETITIVE, $or: replayMatches } },
    { $group: { _id: null,
      wins: { $sum: { $cond: [{ $in: [{ $toLower: "$result" }, ["win", "victory"]] }, 1, 0] } },
      losses: { $sum: { $cond: [{ $in: [{ $toLower: "$result" }, ["loss", "defeat"]] }, 1, 0] } },
    } },
  ], { maxTimeMS: 1000 }).toArray().catch(() => []);
  return counts ? { ...match, h2h: { wins: counts.wins, losses: counts.losses } } : match;
}

module.exports = { streamTitleMatch, streamTitleCompletedMatch };
