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
   * Full operator-facing profile for ONE global player (one real SC2
   * account, identified by ``pulseId``), merged across every user who
   * tracks them. This is the data behind the
   * ``/admin/global/players/<pulseId>`` page: the same merged headline
   * counters the player browser row shows, PLUS a per-user breakdown
   * (which platform users have faced this player and their individual
   * records) and the distribution of the strategies + maps seen across
   * every user's games against them.
   *
   * Returns ``null`` when no user tracks the pulseId so the route can
   * answer 404 cleanly.
   *
   * @param {string} pulseId
   * @returns {Promise<{
   *   pulseId: string,
   *   pulseCharacterId: string | null,
   *   displayNameSample: string,
   *   race: string,
   *   gameCount: number,
   *   wins: number,
   *   losses: number,
   *   winRate: number,
   *   trackedByUsers: number,
   *   mmr: number | null,
   *   leagueId: number | null,
   *   firstSeen: Date | null,
   *   lastSeen: Date | null,
   *   perUser: Array<{
   *     userId: string,
   *     email: string | null,
   *     displayNameSample: string,
   *     race: string,
   *     gameCount: number,
   *     wins: number,
   *     losses: number,
   *     winRate: number,
   *     mmr: number | null,
   *     firstSeen: Date | null,
   *     lastSeen: Date | null,
   *   }>,
   *   strategies: BreakdownRow[],
   *   maps: BreakdownRow[],
   *   generatedAt: string,
   * } | null>}
   */
  async playerProfile(pulseId) {
    if (!pulseId) throw new Error("pulseId required");
    const rows = await this.db.opponents
      .find(
        { pulseId },
        {
          projection: {
            _id: 0,
            userId: 1,
            displayNameSample: 1,
            race: 1,
            pulseCharacterId: 1,
            gameCount: 1,
            wins: 1,
            losses: 1,
            mmr: 1,
            leagueId: 1,
            firstSeen: 1,
            lastSeen: 1,
          },
        },
      )
      .toArray();
    if (rows.length === 0) return null;

    // Merge every user's row for this toon into one record, tracking
    // the most-recently-seen row as the representative for the
    // display name / race / character id (same rule as listPlayers).
    let gameCount = 0;
    let wins = 0;
    let losses = 0;
    /** @type {number | null} */ let mmr = null;
    /** @type {number | null} */ let leagueId = null;
    /** @type {Date | null} */ let firstSeen = null;
    /** @type {Date | null} */ let lastSeen = null;
    /** @type {any} */ let rep = null;
    for (const r of rows) {
      gameCount += Number(r.gameCount) || 0;
      wins += Number(r.wins) || 0;
      losses += Number(r.losses) || 0;
      if (typeof r.mmr === "number") mmr = mmr === null ? r.mmr : Math.max(mmr, r.mmr);
      if (typeof r.leagueId === "number") {
        leagueId = leagueId === null ? r.leagueId : Math.max(leagueId, r.leagueId);
      }
      const fs = r.firstSeen instanceof Date ? r.firstSeen : null;
      const ls = r.lastSeen instanceof Date ? r.lastSeen : null;
      if (fs && (!firstSeen || fs < firstSeen)) firstSeen = fs;
      if (ls && (!lastSeen || ls > lastSeen)) lastSeen = ls;
      if (!rep || (ls && (!rep.lastSeen || ls > rep.lastSeen))) rep = r;
    }

    const emails = await this._emailMap(rows.map((r) => String(r.userId)));
    const perUser = rows
      .map((/** @type {any} */ r) => {
        const gc = Number(r.gameCount) || 0;
        const w = Number(r.wins) || 0;
        return {
          userId: String(r.userId || ""),
          email: emails.get(String(r.userId)) || null,
          displayNameSample: r.displayNameSample || "",
          race: r.race || "",
          gameCount: gc,
          wins: w,
          losses: Number(r.losses) || 0,
          winRate: gc > 0 ? w / gc : 0,
          mmr: typeof r.mmr === "number" ? r.mmr : null,
          firstSeen: r.firstSeen instanceof Date ? r.firstSeen : null,
          lastSeen: r.lastSeen instanceof Date ? r.lastSeen : null,
        };
      })
      .sort((a, b) => b.gameCount - a.gameCount);

    // The opponent's own strategy distribution + the maps they've
    // been faced on, across every user's games — computed in one pass
    // over the games for this toon via ``$facet``.
    const facet = await this.db.games
      .aggregate(
        [
          { $match: pulseGamesMatch(pulseId) },
          {
            $facet: {
              strategies: breakdownStage("$opponent.strategy"),
              maps: breakdownStage("$map"),
            },
          },
        ],
        { allowDiskUse: true },
      )
      .toArray();
    const block = facet[0] || { strategies: [], maps: [] };

    return {
      pulseId: String(pulseId),
      pulseCharacterId:
        rep && typeof rep.pulseCharacterId === "string" && rep.pulseCharacterId
          ? rep.pulseCharacterId
          : null,
      displayNameSample: rep ? rep.displayNameSample || "" : "",
      race: rep ? rep.race || "" : "",
      gameCount,
      wins,
      losses,
      winRate: gameCount > 0 ? wins / gameCount : 0,
      trackedByUsers: rows.length,
      mmr,
      leagueId,
      firstSeen,
      lastSeen,
      perUser,
      strategies: mapBreakdownRows(block.strategies),
      maps: mapBreakdownRows(block.maps),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Every game ANY user played against one global player, newest
   * first, cursor-paginated by ``date`` (``before``). Mirrors the
   * per-user ``listGamesVsOpponent`` shape but drops the userId filter
   * and carries the owning ``userId`` (+ that user's email) on each row
   * so the admin UI can attribute each game and deep-link its build
   * order via the existing ``/admin/users/<userId>/games/<gameId>``
   * endpoints.
   *
   * @param {string} pulseId
   * @param {{ limit?: number, before?: Date }} [opts]
   * @returns {Promise<{
   *   items: Array<{
   *     gameId: string,
   *     userId: string,
   *     userEmail: string | null,
   *     date: Date | null,
   *     result: string | null,
   *     myRace: string | null,
   *     map: string | null,
   *     durationSec: number | null,
   *     myMmr: number | null,
   *     macroScore: number | null,
   *     opponent: {
   *       displayName: string,
   *       race: string,
   *       mmr: number | null,
   *       strategy: string | null,
   *     },
   *   }>,
   *   nextBefore: Date | null,
   * }>}
   */
  async listPlayerGames(pulseId, opts = {}) {
    if (!pulseId) throw new Error("pulseId required");
    const limit = clampLimit(opts.limit, 50);
    /** @type {Record<string, any>} */
    const filter = pulseGamesMatch(pulseId);
    if (opts.before instanceof Date && !Number.isNaN(opts.before.getTime())) {
      filter.date = { $lt: opts.before };
    }
    const rows = await this.db.games
      .find(filter, {
        projection: {
          _id: 0,
          gameId: 1,
          userId: 1,
          date: 1,
          result: 1,
          myRace: 1,
          map: 1,
          durationSec: 1,
          myMmr: 1,
          macroScore: 1,
          opponent: 1,
        },
      })
      .sort({ date: -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const emails = await this._emailMap(page.map((/** @type {any} */ g) => String(g.userId)));
    const items = page.map((/** @type {any} */ g) => {
      const opp = g.opponent || {};
      return {
        gameId: String(g.gameId || ""),
        userId: String(g.userId || ""),
        userEmail: emails.get(String(g.userId)) || null,
        date: g.date instanceof Date ? g.date : null,
        result: g.result || null,
        myRace: g.myRace || null,
        map: g.map || null,
        durationSec: typeof g.durationSec === "number" ? g.durationSec : null,
        myMmr: typeof g.myMmr === "number" ? g.myMmr : null,
        macroScore: typeof g.macroScore === "number" ? g.macroScore : null,
        opponent: {
          displayName: opp.displayName || "",
          race: opp.race || "",
          mmr: typeof opp.mmr === "number" ? opp.mmr : null,
          strategy: typeof opp.strategy === "string" ? opp.strategy : null,
        },
      };
    });
    return {
      items,
      nextBefore: hasMore && page.length > 0 ? page[page.length - 1].date : null,
    };
  }

  /**
   * Resolve a set of userIds to their account email in one query.
   * Returns a Map keyed by userId; missing users simply aren't keyed.
   *
   * @private
   * @param {string[]} userIds
   * @returns {Promise<Map<string, string | null>>}
   */
  async _emailMap(userIds) {
    /** @type {Map<string, string | null>} */
    const map = new Map();
    const distinct = [...new Set(userIds.filter((id) => id))];
    if (distinct.length === 0 || !this.db.users) return map;
    const users = await this.db.users
      .find(
        { userId: { $in: distinct } },
        { projection: { _id: 0, userId: 1, email: 1 } },
      )
      .toArray();
    for (const u of users) {
      map.set(String(u.userId), typeof u.email === "string" ? u.email : null);
    }
    return map;
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
 * Match games against one real player by toon. A game stores the
 * opponent's pulse id either at the top level (``oppPulseId``) or
 * nested (``opponent.pulseId``) depending on the era it was synced, so
 * both are checked — the same predicate the per-user drill-down uses.
 *
 * @param {string} pulseId
 * @returns {Record<string, any>}
 */
function pulseGamesMatch(pulseId) {
  return { $or: [{ oppPulseId: pulseId }, { "opponent.pulseId": pulseId }] };
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
