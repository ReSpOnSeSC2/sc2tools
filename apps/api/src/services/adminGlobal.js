"use strict";

/**
 * AdminGlobalService — platform-wide ("global") tracking for the
 * ``/admin/global`` tab.
 *
 * The per-user services answer "what does THIS user know about their
 * opponents?". This service answers the operator-facing question
 * "what does the platform know in aggregate?" — every player anyone is
 * tracking, merged across users, plus the global distribution of the
 * strategies, builds, and maps we track per user.
 *
 * Identity merge
 * --------------
 * The ``opponents`` collection stores one row per ``(userId, pulseId)``
 * — the same real SC2 account appears once per user who has faced
 * them. ``pulseId`` is the sc2reader toon handle
 * (``region-S2-realm-bnid``), which is stable per real account, so
 * grouping by ``pulseId`` collapses every user's row for one opponent
 * into a single global player record (summing games/wins/losses and
 * counting how many distinct users track them).
 *
 * All data is real: every aggregate is computed from the live
 * ``opponents`` / ``games`` collections and the shared
 * ``pulse_accounts`` cache. No fixtures, no synthetic rows.
 *
 * Authorization is the route layer's job (``isAdmin``); this stays a
 * pure data layer, easy to unit-test against an in-memory Mongo.
 */

// Whitelisted sort columns for the global player browser. Anything
// outside this set falls back to ``gameCount`` so a bad query param
// can never inject a field path into the sort stage.
const PLAYER_SORT_FIELDS = new Set([
  "gameCount",
  "wins",
  "losses",
  "winRate",
  "trackedByUsers",
  "lastSeen",
  "firstSeen",
  "mmr",
]);

// Hard ceiling on breakdown rows so a pathological dataset can't return
// thousands of long-tail strategies in one payload.
const BREAKDOWN_LIMIT = 25;

class AdminGlobalService {
  /**
   * @param {{
   *   db: import('../db/connect').DbContext,
   *   pulseDirectory?: import('./pulseDirectory').PulseDirectoryService | null,
   * }} deps
   */
  constructor(deps) {
    if (!deps || !deps.db) throw new Error("AdminGlobalService: db required");
    this.db = deps.db;
    this.pulseDirectory = deps.pulseDirectory || null;
  }

  /**
   * Headline counters for the Global tab. Distinct-player and
   * distinct-user counts run as cheap grouped counts; the shared
   * SC2Pulse cache contributes resolve / MMR coverage so the operator
   * can see how much of the opponent population has been pulled.
   *
   * @returns {Promise<{
   *   trackedPlayers: number,
   *   opponentRows: number,
   *   usersTracking: number,
   *   totalGames: number,
   *   cache: { total: number, resolved: number, mmrCached: number },
   *   generatedAt: string,
   * }>}
   */
  async summary() {
    const [
      trackedPlayers,
      opponentRows,
      usersTracking,
      totalGames,
      cache,
    ] = await Promise.all([
      this._countDistinct(this.db.opponents, "$pulseId"),
      this.db.opponents.estimatedDocumentCount(),
      this._countDistinct(this.db.opponents, "$userId"),
      this.db.games.estimatedDocumentCount(),
      this.pulseDirectory
        ? this.pulseDirectory.stats()
        : Promise.resolve({ total: 0, resolved: 0, mmrCached: 0 }),
    ]);
    return {
      trackedPlayers,
      opponentRows: Number(opponentRows) || 0,
      usersTracking,
      totalGames: Number(totalGames) || 0,
      cache,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Paginated, filterable list of global player records — every
   * opponent anyone tracks, merged across users.
   *
   * @param {{
   *   limit?: number,
   *   page?: number,
   *   search?: string,
   *   race?: string,
   *   minGames?: number,
   *   sort?: string,
   *   order?: string,
   * }} [opts]
   * @returns {Promise<{
   *   items: Array<{
   *     pulseId: string,
   *     pulseCharacterId: string | null,
   *     displayNameSample: string,
   *     race: string,
   *     gameCount: number,
   *     wins: number,
   *     losses: number,
   *     winRate: number,
   *     trackedByUsers: number,
   *     mmr: number | null,
   *     leagueId: number | null,
   *     firstSeen: Date | null,
   *     lastSeen: Date | null,
   *   }>,
   *   total: number,
   *   page: number,
   *   limit: number,
   *   hasMore: boolean,
   *   races: string[],
   * }>}
   */
  async listPlayers(opts = {}) {
    const limit = clampLimit(opts.limit, 50);
    const page =
      typeof opts.page === "number" && Number.isInteger(opts.page) && opts.page > 0
        ? opts.page
        : 0;
    const offset = page * limit;
    const sortField =
      typeof opts.sort === "string" && PLAYER_SORT_FIELDS.has(opts.sort)
        ? opts.sort
        : "gameCount";
    const order = opts.order === "asc" ? 1 : -1;

    // Group every user's row for the same toon into one player record.
    // ``$top`` picks the most-recently-seen representative for the
    // display name / race / character id WITHOUT a global pre-sort
    // (it sorts only within each group), so this stays cheap on a
    // large opponents collection.
    /** @type {Record<string, any>} */
    const postMatch = {};
    if (typeof opts.search === "string" && opts.search.trim().length > 0) {
      const re = new RegExp(escapeRegex(opts.search.trim()), "i");
      postMatch.$or = [{ displayNameSample: re }, { _id: re }];
    }
    if (
      typeof opts.race === "string" &&
      opts.race.length > 0 &&
      opts.race !== "all"
    ) {
      postMatch.race = opts.race;
    }
    if (typeof opts.minGames === "number" && opts.minGames > 0) {
      postMatch.gameCount = { $gte: opts.minGames };
    }

    const sortSpec = { [sortField]: order, _id: 1 };

    /** @type {any[]} */
    const pipeline = [
      {
        $group: {
          _id: "$pulseId",
          rep: {
            $top: {
              sortBy: { lastSeen: -1 },
              output: {
                displayNameSample: "$displayNameSample",
                race: "$race",
                pulseCharacterId: "$pulseCharacterId",
              },
            },
          },
          gameCount: { $sum: "$gameCount" },
          wins: { $sum: "$wins" },
          losses: { $sum: "$losses" },
          trackedByUsers: { $sum: 1 },
          mmr: { $max: "$mmr" },
          leagueId: { $max: "$leagueId" },
          firstSeen: { $min: "$firstSeen" },
          lastSeen: { $max: "$lastSeen" },
        },
      },
      {
        $addFields: {
          displayNameSample: "$rep.displayNameSample",
          race: "$rep.race",
          pulseCharacterId: "$rep.pulseCharacterId",
          winRate: {
            $cond: [
              { $gt: ["$gameCount", 0] },
              { $divide: ["$wins", "$gameCount"] },
              0,
            ],
          },
        },
      },
    ];
    if (Object.keys(postMatch).length > 0) {
      pipeline.push({ $match: postMatch });
    }
    pipeline.push({
      $facet: {
        items: [
          { $sort: sortSpec },
          { $skip: offset },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              pulseId: "$_id",
              pulseCharacterId: 1,
              displayNameSample: 1,
              race: 1,
              gameCount: 1,
              wins: 1,
              losses: 1,
              winRate: 1,
              trackedByUsers: 1,
              mmr: 1,
              leagueId: 1,
              firstSeen: 1,
              lastSeen: 1,
            },
          },
        ],
        total: [{ $count: "n" }],
      },
    });

    const [facet, races] = await Promise.all([
      this.db.opponents.aggregate(pipeline, { allowDiskUse: true }).toArray(),
      this.db.opponents.distinct("race"),
    ]);

    const block = facet[0] || { items: [], total: [] };
    const total =
      block.total && block.total[0] ? Number(block.total[0].n) || 0 : 0;
    const items = (block.items || []).map((/** @type {any} */ o) => ({
      pulseId: String(o.pulseId || ""),
      pulseCharacterId:
        typeof o.pulseCharacterId === "string" && o.pulseCharacterId
          ? o.pulseCharacterId
          : null,
      displayNameSample: o.displayNameSample || "",
      race: o.race || "",
      gameCount: Number(o.gameCount) || 0,
      wins: Number(o.wins) || 0,
      losses: Number(o.losses) || 0,
      winRate: Number(o.winRate) || 0,
      trackedByUsers: Number(o.trackedByUsers) || 0,
      mmr: typeof o.mmr === "number" ? o.mmr : null,
      leagueId: typeof o.leagueId === "number" ? o.leagueId : null,
      firstSeen: o.firstSeen instanceof Date ? o.firstSeen : null,
      lastSeen: o.lastSeen instanceof Date ? o.lastSeen : null,
    }));
    return {
      items,
      total,
      page,
      limit,
      hasMore: offset + items.length < total,
      races: (races || [])
        .filter((/** @type {unknown} */ r) => typeof r === "string" && r.length > 0)
        .sort(),
    };
  }

  /**
   * Platform-wide distribution of the strategies, builds, and maps we
   * track per user — computed in one pass over ``games`` via ``$facet``
   * so a single collection scan feeds all three rollups. Each row
   * carries a play count and a win rate (from the uploader's
   * perspective), sorted by frequency and capped at ``BREAKDOWN_LIMIT``.
   *
   * @returns {Promise<{
   *   strategies: BreakdownRow[],
   *   builds: BreakdownRow[],
   *   maps: BreakdownRow[],
   *   generatedAt: string,
   * }>}
   *
   * @typedef {{ key: string, count: number, wins: number, winRate: number }} BreakdownRow
   */
  async breakdowns() {
    const facet = await this.db.games
      .aggregate(
        [
          {
            $facet: {
              strategies: breakdownStage("$opponent.strategy"),
              builds: breakdownStage("$myBuild"),
              maps: breakdownStage("$map"),
            },
          },
        ],
        { allowDiskUse: true },
      )
      .toArray();
    const block = facet[0] || { strategies: [], builds: [], maps: [] };
    return {
      strategies: mapBreakdownRows(block.strategies),
      builds: mapBreakdownRows(block.builds),
      maps: mapBreakdownRows(block.maps),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * @private
   * @param {import('mongodb').Collection} collection
   * @param {string} field — a ``$``-prefixed field path to group on.
   * @returns {Promise<number>}
   */
  async _countDistinct(collection, field) {
    const rows = await collection
      .aggregate([{ $group: { _id: field } }, { $count: "n" }])
      .toArray();
    return rows[0] ? Number(rows[0].n) || 0 : 0;
  }
}

/**
 * Build the ``$facet`` sub-pipeline for one breakdown dimension:
 * drop rows missing the field, group + tally wins, sort by frequency,
 * cap. Shared by strategies / builds / maps so the three stay
 * identically shaped.
 *
 * @param {string} field — ``$``-prefixed field path.
 * @returns {object[]}
 */
function breakdownStage(field) {
  return [
    { $match: { [field.slice(1)]: { $type: "string", $ne: "" } } },
    {
      $group: {
        _id: field,
        count: { $sum: 1 },
        wins: {
          $sum: { $cond: [{ $eq: ["$result", "Victory"] }, 1, 0] },
        },
      },
    },
    { $sort: { count: -1, _id: 1 } },
    { $limit: BREAKDOWN_LIMIT },
  ];
}

/**
 * @param {any[]|undefined} rows
 * @returns {Array<{ key: string, count: number, wins: number, winRate: number }>}
 */
function mapBreakdownRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const count = Number(r.count) || 0;
    const wins = Number(r.wins) || 0;
    return {
      key: String(r._id || ""),
      count,
      wins,
      winRate: count > 0 ? wins / count : 0,
    };
  });
}

/** @param {unknown} raw @param {number} fallback */
function clampLimit(raw, fallback) {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 200);
}

/** @param {string} s */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { AdminGlobalService, PLAYER_SORT_FIELDS, BREAKDOWN_LIMIT };
