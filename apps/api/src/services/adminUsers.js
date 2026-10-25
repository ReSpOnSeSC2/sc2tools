"use strict";

const { COLLECTIONS } = require("../config/constants");
const { csvCell } = require("./replayCsv");
const { LIVE_GAME_MATCH } = require("../util/gameVisibility");

const FILTERS = new Set(["all", "with_games", "no_games", "with_agent", "signed_up_7d", "agent_inactive_14d", "admins"]);
const SORTS = Object.freeze({ lastActivity: "sortKey", createdAt: "createdAt", games: "gameStats.gameCount", opponents: "opponentCount", agentLastSeen: "agentStats.lastSeenAt" });
const DERIVED_FILTERS = new Set(["with_games", "no_games", "with_agent", "agent_inactive_14d"]);
const DAY = 86_400_000;
const EXPORT_LIMIT = 10_000;
const CSV_COLUMNS = ["userId", "clerkUserId", "email", "signedUpAt", "lastActivity", "games", "opponents", "agentPaired", "agentLastSeen", "isAdmin"];

/** @param {unknown} value @param {number} fallback @param {number} max */
function integer(value, fallback, max) { return Number.isSafeInteger(value) && Number(value) > 0 ? Math.min(Number(value), max) : fallback; }
/** @param {string} value */
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
/** @param {unknown} value */
function date(value) { return value instanceof Date && Number.isFinite(+value) ? value : null; }

/** @param {Record<string,any>} options @param {string[]} adminIds @param {Date} now */
function scope(options, adminIds, now) {
  const filter = FILTERS.has(options.filter) ? options.filter : "all";
  const clauses = [];
  if (typeof options.search === "string" && options.search.trim()) {
    const re = new RegExp(escapeRegex(options.search.trim().slice(0, 200)), "i");
    clauses.push({ $or: [{ userId: re }, { clerkUserId: re }, { email: re }] });
  }
  if (filter === "signed_up_7d") clauses.push({ createdAt: { $gte: new Date(+now - 7 * DAY) } });
  if (filter === "admins") clauses.push({ $or: [{ role: "admin" }, { clerkUserId: { $in: adminIds } }] });
  return { filter, match: clauses.length ? { $and: clauses } : {}, cutoff: new Date(+now - 14 * DAY) };
}

/** @returns {import('mongodb').Document[]} */
function gameLookup() {
  return [
    { $lookup: { from: COLLECTIONS.GAMES, let: { uid: "$userId" }, pipeline: [
      { $match: { ...LIVE_GAME_MATCH, $expr: { $eq: ["$userId", "$$uid"] } } },
      { $group: { _id: null, gameCount: { $sum: 1 }, firstActivity: { $min: "$date" }, lastActivity: { $max: "$date" } } },
    ], as: "gameStats" } },
    { $set: { gameStats: { $ifNull: [{ $arrayElemAt: ["$gameStats", 0] }, { gameCount: 0, firstActivity: null, lastActivity: null }] } } },
  ];
}
/** @returns {import('mongodb').Document[]} */
function agentLookup() {
  return [
    // Preserve the existing paired-at-least-once cohort: retained revoked rows
    // are historical installations too. Missing heartbeat is unknown, not old.
    { $lookup: { from: COLLECTIONS.DEVICE_TOKENS, let: { uid: "$userId" }, pipeline: [
      { $match: { $expr: { $eq: ["$userId", "$$uid"] } } },
      { $group: { _id: null, count: { $sum: 1 }, lastSeenAt: { $max: "$lastSeenAt" } } },
    ], as: "agentStats" } },
    { $set: { agentStats: { $ifNull: [{ $arrayElemAt: ["$agentStats", 0] }, { count: 0, lastSeenAt: null }] } } },
  ];
}
/** @returns {import('mongodb').Document[]} */
function opponentLookup() {
  return [
    { $lookup: { from: COLLECTIONS.OPPONENTS, let: { uid: "$userId" }, pipeline: [
      { $match: { $expr: { $eq: ["$userId", "$$uid"] } } }, { $count: "count" },
    ], as: "opponentStats" } },
    { $set: { opponentCount: { $ifNull: [{ $arrayElemAt: ["$opponentStats.count", 0] }, 0] } } },
  ];
}
/** @param {ReturnType<typeof scope>} selected */
function derivedMatch(selected) {
  switch (selected.filter) {
    case "with_games": return { "gameStats.gameCount": { $gt: 0 } };
    case "no_games": return { "gameStats.gameCount": 0 };
    case "with_agent": return { "agentStats.count": { $gt: 0 } };
    case "agent_inactive_14d": return { "agentStats.count": { $gt: 0 }, "agentStats.lastSeenAt": { $type: "date", $lt: selected.cutoff } };
    default: return {};
  }
}

/** Group indexed games once for count sorts, join real users, then add their
 * zero-game counterparts. Legacy orphan game owners never become accounts.
 * Revisit at about 20k users, or once faster-dashboards stores users.gameStats.
 * @param {Record<string,any>} match @returns {import('mongodb').Document[]} */
function groupedGames(match) {
  return [
    { $match: LIVE_GAME_MATCH },
    { $sort: { userId: 1 } },
    { $group: { _id: "$userId", gameCount: { $sum: 1 }, firstActivity: { $min: "$date" }, lastActivity: { $max: "$date" } } },
    { $lookup: { from: COLLECTIONS.USERS, localField: "_id", foreignField: "userId", pipeline: [{ $match: match }], as: "owner" } },
    { $unwind: "$owner" },
    { $replaceRoot: { newRoot: { $mergeObjects: ["$owner", { gameStats: { gameCount: "$gameCount", firstActivity: "$firstActivity", lastActivity: "$lastActivity" } }] } } },
    { $unionWith: { coll: COLLECTIONS.USERS, pipeline: [{ $match: match }, { $set: { gameStats: { gameCount: 0, firstActivity: null, lastActivity: null } } }] } },
    { $group: { _id: "$userId", owner: { $first: "$$ROOT" }, gameCount: { $max: "$gameStats.gameCount" }, firstActivity: { $max: "$gameStats.firstActivity" }, lastActivity: { $max: "$gameStats.lastActivity" } } },
    { $replaceRoot: { newRoot: { $mergeObjects: ["$owner", { gameStats: { gameCount: "$gameCount", firstActivity: "$firstActivity", lastActivity: "$lastActivity" } }] } } },
  ];
}

class AdminUsersService {
  /** @param {import('../db/connect').DbContext} db @param {{adminIds?:()=>string[],now?:()=>Date}} [options] */
  constructor(db, options = {}) { this.db = db; this.adminIds = options.adminIds || (() => []); this.now = options.now || (() => new Date()); }

  /** @param {Record<string,any>} options */
  selection(options) { const ids = this.adminIds(); return { ...scope(options, ids, this.now()), ids }; }

  /** Literal user filters can use countDocuments. Derived game/device filters
   * need the identical post-lookup predicate; materializing all user IDs merely
   * to call countDocuments would make account growth an unbounded API array.
   * @param {ReturnType<AdminUsersService['selection']>} selected */
  async total(selected) {
    if (!DERIVED_FILTERS.has(selected.filter)) return this.db.users.countDocuments(selected.match, { maxTimeMS: 30_000 });
    const pipeline = [{ $match: selected.match }, ...gameLookup(), ...agentLookup(), { $match: derivedMatch(selected) }, { $count: "total" }];
    return Number((await this.db.users.aggregate(pipeline, { maxTimeMS: 30_000 }).next())?.total) || 0;
  }

  /** @param {Record<string,any>} options @param {ReturnType<AdminUsersService['selection']>} selected @param {number} limit @param {number} skip */
  cursor(options, selected, limit, skip) {
    const sort = Object.hasOwn(SORTS, options.sort) ? options.sort : "lastActivity";
    const grouped = sort === "games" || sort === "opponents";
    const source = grouped ? this.db.games : this.db.users;
    const pipeline = /** @type {import('mongodb').Document[]} */ (grouped ? groupedGames(selected.match) : [{ $match: selected.match }, ...gameLookup()]);
    pipeline.push(...agentLookup(), { $match: derivedMatch(selected) });
    if (sort === "opponents") pipeline.push(...opponentLookup());
    pipeline.push({ $set: { sortKey: { $ifNull: ["$gameStats.lastActivity", { $ifNull: ["$lastSeenAt", "$createdAt"] }] } } });
    if (options.before instanceof Date && Number.isFinite(+options.before)) pipeline.push({ $match: { sortKey: { $lt: options.before } } });
    pipeline.push({ $sort: { [SORTS[/** @type {keyof typeof SORTS} */ (sort)]]: options.order === "asc" ? 1 : -1, userId: 1 } }, { $skip: skip }, { $limit: limit });
    if (sort !== "opponents") pipeline.push(...opponentLookup());
    pipeline.push({ $project: { _id: 0, userId: 1, clerkUserId: 1, email: 1, createdAt: 1, role: 1, gameStats: 1, agentStats: 1, opponentCount: 1, sortKey: 1 } });
    return source.aggregate(pipeline, { maxTimeMS: 30_000, ...(grouped ? { hint: { userId: 1, date: -1 } } : {}), ...(options.signal ? { signal: options.signal } : {}) }).batchSize(100);
  }

  /** @param {Record<string,any>} row @param {string[]} ids */
  row(row, ids) {
    return { userId: String(row.userId || ""), clerkUserId: row.clerkUserId ? String(row.clerkUserId) : null, email: row.email ? String(row.email) : null,
      createdAt: date(row.createdAt), isAdmin: row.role === "admin" || ids.includes(row.clerkUserId),
      gameCount: Number(row.gameStats?.gameCount) || 0, opponentCount: Number(row.opponentCount) || 0,
      firstActivity: date(row.gameStats?.firstActivity), lastActivity: date(row.sortKey),
      hasAgent: Number(row.agentStats?.count) > 0, agentLastSeenAt: date(row.agentStats?.lastSeenAt) };
  }

  /** @param {Record<string,any>} [options] */
  async list(options = {}) {
    const limit = integer(options.limit, 50, 200), page = integer(options.page, 1, 10_000), selected = this.selection(options);
    const [rows, total] = await Promise.all([this.cursor(options, selected, limit + 1, (page - 1) * limit).toArray(), this.total(selected)]);
    const hasMore = rows.length > limit, shown = rows.slice(0, limit);
    return { items: shown.map(row => this.row(row, selected.ids)), total, page, limit, hasMore,
      nextBefore: hasMore && shown.length ? date(shown[shown.length - 1].sortKey) : null };
  }

  /** @param {Record<string,any>} [options] */
  async prepareCsv(options = {}) {
    const selected = this.selection(options), total = await this.total(selected), self = this;
    // Counts and this admission flag describe the export-start read. The
    // cursor is bounded but not a cross-collection snapshot transaction;
    // concurrent account/game changes can alter the rows that follow.
    const truncated = total > EXPORT_LIMIT;
    async function* stream() {
      yield `\uFEFF${CSV_COLUMNS.join(",")}\r\n`;
      const cursor = self.cursor({ ...options, before: undefined, sort: "lastActivity", order: "desc" }, selected, EXPORT_LIMIT, 0);
      try {
        for await (const raw of cursor) {
          options.signal?.throwIfAborted();
          const row = self.row(raw, selected.ids);
          const cells = [row.userId, row.clerkUserId, row.email, row.createdAt?.toISOString(), row.lastActivity?.toISOString(), row.gameCount, row.opponentCount, row.hasAgent, row.agentLastSeenAt?.toISOString(), row.isAdmin];
          yield `${cells.map(csvCell).join(",")}\r\n`;
        }
      } finally { await cursor.close(); }
    }
    return { total, truncated, stream: stream() };
  }
}

module.exports = { AdminUsersService, FILTERS, SORTS, EXPORT_LIMIT, CSV_COLUMNS };
