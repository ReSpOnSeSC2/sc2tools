"use strict";

const { globalHistoryStages, playerIncluded } = require("./adminGlobalTrendsScope");
const { regionFromToonHandle } = require("../util/regionFromToonHandle");

/** Read contributors, rather than opponents encountered by contributors.
 * There is no total-row cap: HTTP pagination happens after all identities
 * have been resolved, so search/MMR sorting always cover the entire roster.
 * @param {import('../db/connect').DbContext} db */
async function readGlobalPlayers(db) {
  const rows = await db.games.aggregate([
    ...globalHistoryStages(),
    { $group: {
      _id: "$_globalPlayerId", toonHandle: { $first: "$_globalToon" },
      userIds: { $addToSet: "$userId" }, gameCount: { $sum: 1 },
      races: { $addToSet: "$_globalPlayedRace" }, lastSeen: { $max: "$date" },
      latest: { $top: { sortBy: { date: -1, gameId: 1 }, output: { race: "$_globalPlayedRace" } } },
      rating: { $top: {
        sortBy: { _globalTrustedMmr: -1, date: -1, gameId: 1 },
        output: { trusted: "$_globalTrustedMmr", mmr: "$myMmr", date: "$date" },
      } },
    } },
    { $lookup: {
      from: db.pulseAccounts.collectionName, localField: "toonHandle", foreignField: "toonHandle", as: "pulse",
      pipeline: [{ $project: { _id: 0, mmr: 1, mmrFetchedAt: 1, displayNameSample: 1 } }],
    } },
    { $lookup: {
      from: db.users.collectionName, localField: "userIds", foreignField: "userId", as: "owners",
      pipeline: [{ $project: { _id: 0, displayName: 1 } }],
    } },
  ], { allowDiskUse: true, maxTimeMS: 60000 }).toArray();
  return rows.map((row) => shapePlayer(row));
}

/** @param {Record<string, any>} row */
function shapePlayer(row) {
  const pulse = row.pulse?.[0];
  const rating = row.rating?.trusted === true ? row.rating : null;
  const pulseDate = pulse?.mmrFetchedAt instanceof Date ? pulse.mmrFetchedAt : null;
  const replayDate = rating?.date instanceof Date ? rating.date : null;
  const pulseIsNewer = typeof pulse?.mmr === "number" && pulse.mmr > 0 && pulseDate
    && (!replayDate || pulseDate.getTime() >= replayDate.getTime());
  const currentMmr = pulseIsNewer ? pulse.mmr : rating?.mmr ?? null;
  const playerId = String(row._id);
  const toon = row.toonHandle || null;
  const ownerName = row.owners?.find((/** @type {any} */ v) => v.displayName)?.displayName;
  const displayName = toon
    ? pulse?.displayNameSample || ownerName || toon
    : `Legacy history${ownerName ? ` · ${ownerName}` : ` · ${playerId.slice(5)}`}`;
  return {
    playerId, displayName, toonHandle: toon, identitySource: toon ? "toon" : "uploader",
    race: row.latest?.race || "U", races: (row.races || []).sort(),
    region: toon ? regionFromToonHandle(toon) : null,
    currentMmr, mmrSource: pulseIsNewer ? "pulse" : rating ? "replay" : null,
    mmrUpdatedAt: pulseIsNewer ? pulseDate : replayDate,
    gameCount: row.gameCount || 0, lastSeen: row.lastSeen || null,
  };
}

/** @param {Awaited<ReturnType<typeof readGlobalPlayers>>} players
 * @param {import('./adminGlobalTrendsScope').Cohort} cohort
 * @param {Record<string, unknown>} query */
function paginatePlayers(players, cohort, query) {
  const page = Math.max(0, Math.floor(Number(query.page) || 0));
  const limit = Math.max(1, Math.min(200, Math.floor(Number(query.limit) || 50)));
  const search = String(query.search || "").trim().toLowerCase().slice(0, 128);
  const sort = ({ name: "displayName", mmr: "currentMmr", gameCount: "gameCount", lastSeen: "lastSeen" })[String(query.sort)] || "gameCount";
  const direction = query.order === "asc" ? 1 : -1;
  const items = players.map((player) => ({ ...player, included: playerIncluded(player, cohort) }));
  const selectedTotal = items.filter((player) => player.included).length;
  const visible = items.filter((p) => !search || `${p.displayName} ${p.playerId} ${p.region || ""}`.toLowerCase().includes(search));
  visible.sort((a, b) => {
    const av = /** @type {any} */ (a)[sort];
    const bv = /** @type {any} */ (b)[sort];
    // Unknown ratings stay last in both directions.
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    const compared = typeof av === "string" ? av.localeCompare(bv) : av > bv ? 1 : av < bv ? -1 : 0;
    return compared * direction || a.playerId.localeCompare(b.playerId);
  });
  return {
    items: visible.slice(page * limit, (page + 1) * limit),
    total: visible.length, rosterTotal: players.length, selectedTotal, page, limit,
    hasMore: (page + 1) * limit < visible.length,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { readGlobalPlayers, paginatePlayers };
