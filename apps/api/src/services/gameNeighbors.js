"use strict";

const { buildReplayLibraryMatch } = require("./replayLibrary");
const { replayNeighborBranches } = require("./replayLibraryCursor");

/** @typedef {Record<string, any>} Row */
/** @typedef {{games:import('mongodb').Collection,opponents?:import('mongodb').Collection}} NeighborDb */
const NAV_INDEX = Object.freeze({ userId: 1, date: -1, _id: -1 });
const CURRENT_PROJECTION = Object.freeze({ _id: 1, date: 1, gameId: 1, myRace: 1, myBuild: 1,
  "opponent.pulseId": 1, "opponent.race": 1 });
const SUMMARY_PROJECTION = Object.freeze({ _id: 0, gameId: 1, date: 1, result: 1, map: 1, myRace: 1, myBuild: 1,
  "opponent.displayName": 1, "opponent.race": 1, "opponent.pulseId": 1 });
const SCOPES = new Set(["all", "opponent", "matchup", "build"]);

/** @param {unknown} raw @returns {string|null} */
function navigationIdentity(raw) {
  if (typeof raw !== "string" || raw.length > 200 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw.trim() || null;
}

/** @param {unknown} raw @returns {string|null} */
function raceLetter(raw) {
  if (typeof raw !== "string") return null;
  const first = raw.trim().charAt(0).toUpperCase();
  return /^[PTZR]$/.test(first) ? first : null;
}

/** @param {Row} current @param {string} scope @returns {Row|null} */
function navigationScope(current, scope) {
  if (scope === "all") return {};
  if (scope === "opponent") {
    const id = navigationIdentity(current.opponent?.pulseId);
    return id ? { "opponent.pulseId": id } : null;
  }
  if (scope === "build") {
    // Confirmed check-ins write their effective label onto myBuild. Using the
    // stored owner label deliberately avoids detector-only/public remapping.
    const label = navigationIdentity(current.myBuild);
    return label ? { myBuild: label } : null;
  }
  const mine = raceLetter(current.myRace), theirs = raceLetter(current.opponent?.race);
  return mine && theirs ? { myRace: new RegExp(`^${mine}`, "i"), "opponent.race": new RegExp(`^${theirs}`, "i") } : null;
}

/** @param {unknown} raw @param {number} max @returns {string|null} */
function text(raw, max) {
  return typeof raw === "string" ? raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) || null : null;
}

/** @param {Row|null} row @returns {Row|null} */
function neighborSummary(row) {
  const gameId = navigationIdentity(row?.gameId);
  if (!row || !gameId) return null;
  const at = row.date instanceof Date || typeof row.date === "string" || typeof row.date === "number" ? new Date(row.date) : null;
  const pulseId = navigationIdentity(row.opponent?.pulseId);
  return { gameId, date: at && Number.isFinite(at.getTime()) ? at.toISOString() : null,
    result: text(row.result, 24), map: text(row.map, 200), myRace: text(row.myRace, 24), myBuild: text(row.myBuild, 200),
    opponent: { displayName: text(row.opponent?.displayName, 80), race: text(row.opponent?.race, 24), ...(pulseId ? { pulseId } : {}) } };
}

/** Cached owner totals only: a missing/invalid count is never presented as zero.
 * @param {NeighborDb} db @param {string} userId @param {unknown} rawId */
async function cachedHeadToHead(db, userId, rawId) {
  const pulseId = navigationIdentity(rawId);
  if (!pulseId || !db.opponents) return;
  try {
    const row = await db.opponents.findOne({ userId, pulseId }, { projection: { _id: 0, wins: 1, losses: 1, gameCount: 1 } });
    if (!row || !Number.isSafeInteger(row.wins) || !Number.isSafeInteger(row.losses) || row.wins < 0 || row.losses < 0) return;
    const total = row.wins + row.losses;
    if (!Number.isSafeInteger(total) || (total === 0 && !(Number.isSafeInteger(row.gameCount) && row.gameCount > 0))) return;
    if (row.gameCount !== undefined && (!Number.isSafeInteger(row.gameCount) || row.gameCount < total)) return;
    return { wins: row.wins, losses: row.losses };
  } catch {
    // Decorative cached metadata must not make the three navigation reads fail.
    return;
  }
}

/** Three slim, owner-scoped game reads; optional H2H is one indexed cached read.
 * @param {NeighborDb} db @param {string} userId @param {string} gameId
 * @param {{scope?:unknown,filters?:import('../util/parseQuery').GlobalFilters,result?:unknown,matchup?:unknown,search?:unknown}} [opts] */
async function ownedGameNeighbors(db, userId, gameId, opts = {}) {
  const owner = navigationIdentity(userId), id = navigationIdentity(gameId);
  if (!owner || !id) return null;
  const scope = opts.scope === undefined ? "all" : opts.scope;
  if (typeof scope !== "string" || !SCOPES.has(scope)) throw Object.assign(new Error("Invalid game navigation scope"), { status: 400, code: "bad_request" });
  const current = await db.games.findOne({ userId: owner, gameId: id, isResumedFromReplay: { $ne: true } }, { projection: CURRENT_PROJECTION });
  if (!current) return null;
  const scopeMatch = navigationScope(current, scope);
  const h2hPromise = cachedHeadToHead(db, owner, current.opponent?.pulseId);
  if (!scopeMatch) {
    const h2h = await h2hPromise;
    return { prev: null, next: null, ...(h2h ? { h2h } : {}) };
  }
  const match = buildReplayLibraryMatch(owner, { ...opts, view: "owner" });
  const read = (/** @type {'date_desc'|'date_asc'} */ direction) => db.games.findOne(
    { $and: [match, scopeMatch, { $or: replayNeighborBranches(current.date, current._id, direction) }] },
    { projection: SUMMARY_PROJECTION, sort: direction === "date_desc" ? { date: -1, _id: -1 } : { date: 1, _id: 1 }, hint: NAV_INDEX },
  );
  const [prev, next, h2h] = await Promise.all([read("date_desc"), read("date_asc"), h2hPromise]);
  return { prev: neighborSummary(prev), next: neighborSummary(next), ...(h2h ? { h2h } : {}) };
}

module.exports = { ownedGameNeighbors, navigationIdentity };
