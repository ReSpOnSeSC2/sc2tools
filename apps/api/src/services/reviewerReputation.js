"use strict";

const { REVIEWS } = require("../config/constants");
const { cleanDisplayName } = require("../util/contentFilter");
const { bandFromId, approximateMmr } = require("../util/leagueBands");
const { normalizeRace } = require("./reviewRedaction");
const {
  groupLadderRows,
  bestBandFromGames,
  ladderAccounts,
  ladderLeaguesByRegion,
  gameLeaguesByRegion,
  mergeRegionLeagues,
  storedRegions,
  publicRegions,
  isStronger,
} = require("./reviewerLeagues");

const SEASON_WINDOW_TIMEOUT_MS = 3000;
/** SC2Pulse lookup budget for one verification; the games verify alone after it. */
const LADDER_LOOKUP_TIMEOUT_MS = 6000;
/**
 * Shape version of ``users.reviewer.verified``. A cached verification of
 * an older version is recomputed on the next read instead of waiting out
 * VERIFY_TTL_MS (v2 added SC2Pulse leagues and ``regions``).
 */
const VERIFICATION_VERSION = 2;
const VERIFY_SCAN_LIMIT = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Badge ladder. Derived from the materialised ``users.reviewer``
 * counters on every read, never stored, so a rule change applies to
 * everyone at once.
 */
const BADGES = Object.freeze([
  { key: "first_review", label: "First Review", test: (/** @type {ReviewerStats} */ s) => s.reviews >= 1 },
  { key: "helpful_10", label: "Helpful ×10", test: (/** @type {ReviewerStats} */ s) => s.helpful >= 10 },
  { key: "mentor", label: "Mentor", test: (/** @type {ReviewerStats} */ s) => s.helpful >= 50 },
  { key: "best_10", label: "Best Answer ×10", test: (/** @type {ReviewerStats} */ s) => s.best >= 10 },
]);

/**
 * @typedef {{karma: number, helpful: number, best: number, upvotes: number, reviews: number, removed: number}} ReviewerStats
 * @typedef {{
 *   v: number,
 *   band: {id: number, label: string} | null,
 *   race: string | null,
 *   mmr: number | null,
 *   games: number,
 *   regions: Array<{region: string, band: {id: number, label: string}, race: string, mmr: number | null, games: number, source: string}>,
 *   windowStart: Date,
 *   verifiedAt: Date,
 *   reason?: string,
 * }} ReviewerVerification
 * @typedef {{getLadderTeams(ids: string[]): Promise<import('./reviewerLeagues').LadderTeam[]>}} LadderSource
 */

/**
 * ReviewerReputationService — who a reviewer is, as far as the public
 * page is concerned: verified league band and race, overall and per
 * region (from the accounts in their OWN synced ladder games, never
 * self-reported), karma and badges.
 *
 * Deliberately never reads the Coaching Locker: coaching stays private,
 * so nothing here reveals who coaches or who is coached.
 */
class ReviewerReputationService {
  /**
   * @param {import('../db/connect').DbContext} db
   * @param {{
   *   seasons?: {list(): Promise<{items: Array<{battlenetId: number, start: string | null}>, current: number | null, source: string}>},
   *   seasonWindowStart?: () => Promise<Date>,
   *   pulse?: LadderSource | null,
   *   now?: () => number,
   *   logger?: import('pino').Logger,
   * }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.seasons = opts.seasons || null;
    this.pulse = opts.pulse || null;
    this.now = opts.now || (() => Date.now());
    this.logger = opts.logger || null;
    this._seasonWindowStart = opts.seasonWindowStart || null;
  }

  /**
   * Start of the verification window: the previous season's start when
   * the season catalog is reachable, otherwise a fixed look-back.
   *
   * @returns {Promise<Date>}
   */
  async seasonWindowStart() {
    if (this._seasonWindowStart) return this._seasonWindowStart();
    const fallback = new Date(this.now() - REVIEWS.VERIFY_FALLBACK_WINDOW_DAYS * DAY_MS);
    if (!this.seasons) return fallback;
    try {
      const catalog = await withTimeout(this.seasons.list(), SEASON_WINDOW_TIMEOUT_MS);
      if (!catalog || catalog.source !== "pulse" || !Number.isFinite(catalog.current)) return fallback;
      // ``current`` is the global Battle.net season id (max battlenetId);
      // one entry per region, so take the earliest regional start of the
      // previous season.
      const current = Number(catalog.current);
      /** @type {Date | null} */
      let earliest = null;
      for (const season of catalog.items || []) {
        if (season.battlenetId !== current - 1 && season.battlenetId !== current) continue;
        const start = season.start ? new Date(season.start) : null;
        if (start && !Number.isNaN(start.getTime()) && (!earliest || start < earliest)) earliest = start;
      }
      return earliest || fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Cheap "has this account synced at least N games" check.
   *
   * @param {string} userId
   * @param {number} [cap]
   */
  async syncedGameCount(userId, cap = REVIEWS.MIN_SYNCED_GAMES_TO_COMMENT) {
    return this.db.games.countDocuments(
      { userId, isResumedFromReplay: { $ne: true } },
      { limit: cap },
    );
  }

  /**
   * Cached verification, recomputed when older than VERIFY_TTL_MS.
   *
   * @param {string} userId
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<ReviewerVerification>}
   */
  async verification(userId, opts = {}) {
    if (!opts.force) {
      const user = await this.db.users.findOne(
        { userId },
        { projection: { _id: 0, "reviewer.verified": 1 } },
      );
      const cached = user?.reviewer?.verified;
      if (
        cached
        && cached.v === VERIFICATION_VERSION
        && cached.verifiedAt
        && this.now() - new Date(cached.verifiedAt).getTime() < REVIEWS.VERIFY_TTL_MS
      ) {
        return cached;
      }
    }
    const fresh = await this.computeVerification(userId);
    await this.db.users.updateOne(
      { userId },
      { $set: { "reviewer.verified": fresh } },
    );
    return fresh;
  }

  /**
   * The reviewer's verified league, overall and per region.
   *
   * The window's ranked 1v1 games (current or previous season) decide
   * which accounts and regions count. A region's league is the higher of
   * SC2Pulse's current-season league for those accounts and the band the
   * region's games reach (``services/reviewerLeagues.js``). The overall
   * band is the strongest region's, or the band all the games reach
   * together when that is higher (for example games synced before the
   * agent recorded toon handles).
   *
   * Example: Protoss games at ~5,300 MMR on NA and EU, and SC2Pulse
   * placing both accounts in Grandmaster → band Grandmaster, regions
   * [NA Grandmaster Protoss, EU Grandmaster Protoss].
   *
   * @param {string} userId
   * @returns {Promise<ReviewerVerification>}
   */
  async computeVerification(userId) {
    const windowStart = await this.seasonWindowStart();
    const rows = await this.db.games
      .find(
        {
          userId,
          date: { $gte: windowStart },
          myMmr: { $gte: 1, $lte: 8000 },
          // Game-time MMR is only kept when the replay itself carried it,
          // which only happens for ranked games; ``isLadderGame`` is the
          // authoritative flag where the agent reports it (older agents
          // omit it, so only an explicit ``false`` excludes a row).
          myMmrSource: { $ne: "unavailable" },
          isResumedFromReplay: { $ne: true },
          isLadderGame: { $ne: false },
          $or: [
            { matchFormat: "1v1" },
            { matchFormat: { $exists: false }, playerCount: { $in: [2, null] } },
          ],
        },
        { projection: { _id: 0, myRace: 1, myMmr: 1, myToonHandle: 1 } },
      )
      .sort({ date: -1 })
      .limit(VERIFY_SCAN_LIMIT)
      .toArray();
    const { byRace, byRegion } = groupLadderRows(rows);
    const teams = await this.ladderTeams(ladderAccounts(byRegion));
    const regions = mergeRegionLeagues(ladderLeaguesByRegion(teams, byRegion), gameLeaguesByRegion(byRegion));
    const pooled = bestBandFromGames(byRace);
    const best = pooled && (!regions[0] || isStronger(pooled, regions[0])) ? pooled : regions[0] || null;
    const verifiedAt = new Date(this.now());
    if (!best) {
      return {
        v: VERIFICATION_VERSION,
        band: null,
        race: null,
        mmr: null,
        games: rows.length,
        regions: [],
        windowStart,
        verifiedAt,
        reason: "not_enough_ladder_games",
      };
    }
    return {
      v: VERIFICATION_VERSION,
      band: best.band,
      race: best.race,
      mmr: approximateMmr(best.mmr),
      games: best.games,
      regions: storedRegions(regions),
      windowStart,
      verifiedAt,
    };
  }

  /**
   * Current-season SC2Pulse teams for the reviewer's own accounts. Empty
   * when SC2Pulse isn't wired (tests), slow or down; the games still
   * verify a band then.
   *
   * @param {string[]} toons toon handles from the reviewer's synced games
   * @returns {Promise<import('./reviewerLeagues').LadderTeam[]>}
   */
  async ladderTeams(toons) {
    if (!this.pulse || toons.length === 0) return [];
    try {
      const teams = await withTimeout(this.pulse.getLadderTeams(toons), LADDER_LOOKUP_TIMEOUT_MS);
      return Array.isArray(teams) ? teams : [];
    } catch (err) {
      const reason = err instanceof Error && err.message === "timeout" ? "timeout" : "error";
      this.logger?.warn({ reason }, "reviewer_ladder_lookup_failed");
      return [];
    }
  }

  /**
   * Public identity + badges for a set of reviewers, batched for one page
   * of comments.
   *
   * @param {string[]} userIds
   * @returns {Promise<Map<string, Record<string, any>>>}
   */
  async publicProfiles(userIds) {
    const ids = [...new Set(userIds.filter((id) => typeof id === "string" && id))];
    /** @type {Map<string, Record<string, any>>} */
    const out = new Map();
    if (ids.length === 0) return out;
    const [users, publicAuthors] = await Promise.all([
      this.db.users
        .find(
          { userId: { $in: ids } },
          { projection: { _id: 0, userId: 1, displayName: 1, battleTag: 1, reviewer: 1 } },
        )
        .toArray()
        .then((rows) => /** @type {Array<Record<string, any>>} */ (rows)),
      this.db.communityBuilds.distinct("ownerUserId", {
        ownerUserId: { $in: ids },
        removed: false,
        authorName: { $type: "string", $ne: "" },
      }),
    ]);
    const hasPublicProfile = new Set(publicAuthors);
    for (const user of users) {
      const stats = reviewerStats(user.reviewer);
      const verified = publicVerification(user.reviewer?.verified);
      out.set(user.userId, {
        name: publicName(user),
        profileHref: hasPublicProfile.has(user.userId)
          ? `/p/${encodeURIComponent(user.userId)}`
          : null,
        verified,
        karma: stats.karma,
        badges: badgesFor(stats),
        flair: flairFor(stats, verified),
      });
    }
    return out;
  }

  /**
   * Apply one ledger outcome to the reviewer's materialised totals.
   *
   * @param {string} userId
   * @param {Partial<Record<keyof ReviewerStats, number>>} delta
   */
  async applyStats(userId, delta) {
    /** @type {Record<string, number>} */
    const inc = {};
    for (const [key, value] of Object.entries(delta)) {
      if (typeof value === "number" && value !== 0) inc[`reviewer.${key}`] = value;
    }
    if (Object.keys(inc).length === 0) return;
    await this.db.users.updateOne({ userId }, { $inc: inc });
  }

  /**
   * Rebuild a reviewer's totals from the ledger + comments. Used by the
   * admin tooling and as the drift repair for the $inc fast path.
   *
   * @param {string} userId
   * @returns {Promise<ReviewerStats>}
   */
  async recomputeStats(userId) {
    const [ledger, reviews] = await Promise.all([
      this.db.reviewKarmaEvents
        .aggregate([
          { $match: { userId } },
          { $group: { _id: "$kind", points: { $sum: "$points" }, count: { $sum: 1 } } },
        ])
        .toArray(),
      this.db.reviewComments.countDocuments({
        authorId: userId,
        parentId: null,
        isAskerComment: { $ne: true },
        status: { $in: ["visible", "hidden"] },
      }),
    ]);
    /** @type {ReviewerStats} */
    const stats = { karma: 0, helpful: 0, best: 0, upvotes: 0, reviews, removed: 0 };
    for (const row of ledger) {
      stats.karma += Number(row.points) || 0;
      if (row._id === "helpful") stats.helpful = row.count;
      if (row._id === "best") stats.best = row.count;
      if (row._id === "upvote") stats.upvotes = row.count;
      if (row._id === "removed") stats.removed = row.count;
    }
    await this.db.users.updateOne(
      { userId },
      {
        $set: {
          "reviewer.karma": stats.karma,
          "reviewer.helpful": stats.helpful,
          "reviewer.best": stats.best,
          "reviewer.upvotes": stats.upvotes,
          "reviewer.reviews": stats.reviews,
          "reviewer.removed": stats.removed,
        },
      },
    );
    return stats;
  }

  /**
   * @param {string} userId
   * @param {boolean} optIn
   */
  async setLeaderboardOptIn(userId, optIn) {
    await this.db.users.updateOne(
      { userId },
      { $set: { "reviewer.leaderboardOptIn": optIn === true } },
    );
    return { leaderboardOptIn: optIn === true };
  }

  /**
   * @param {string} userId
   * @param {boolean} optOut
   */
  async setDigestOptOut(userId, optOut) {
    await this.db.users.updateOne(
      { userId },
      { $set: { "reviewer.digestOptOut": optOut === true } },
    );
  }

  /**
   * The signed-in reviewer's own card.
   *
   * @param {string} userId
   */
  async me(userId) {
    const [user, verified, games] = await Promise.all([
      this.db.users.findOne({ userId }, { projection: { _id: 0, reviewer: 1, displayName: 1, battleTag: 1 } }),
      this.verification(userId),
      this.syncedGameCount(userId),
    ]);
    const stats = reviewerStats(user?.reviewer);
    const publicVerified = publicVerification(verified);
    return {
      name: publicName(/** @type {Record<string, any>} */ (user || {})),
      stats,
      badges: badgesFor(stats),
      flair: flairFor(stats, publicVerified),
      verified: publicVerified,
      canComment: games >= REVIEWS.MIN_SYNCED_GAMES_TO_COMMENT,
      syncedGames: games,
      requiredGames: REVIEWS.MIN_SYNCED_GAMES_TO_COMMENT,
      leaderboardOptIn: user?.reviewer?.leaderboardOptIn === true,
      weeklyDigest: user?.reviewer?.digestOptOut !== true,
    };
  }

  /**
   * Weekly reviewer leaderboard (ISO week, UTC). Only reviewers who
   * opted in to a public name appear; everyone else's karma still counts
   * for their own badges.
   *
   * @returns {Promise<{weekStart: string, items: Array<Record<string, any>>}>}
   */
  async weeklyLeaderboard() {
    const weekStart = isoWeekStart(new Date(this.now()));
    const rows = await this.db.reviewKarmaEvents
      .aggregate([
        { $match: { createdAt: { $gte: weekStart }, userId: { $type: "string" } } },
        { $group: { _id: "$userId", points: { $sum: "$points" }, helpful: { $sum: { $cond: [{ $eq: ["$kind", "helpful"] }, 1, 0] } }, best: { $sum: { $cond: [{ $eq: ["$kind", "best"] }, 1, 0] } } } },
        { $match: { points: { $gt: 0 } } },
        { $sort: { points: -1, _id: 1 } },
        { $limit: 200 },
      ])
      .toArray();
    const ids = rows.map((r) => r._id);
    const optedIn = new Set(
      (await this.db.users
        .find({ userId: { $in: ids }, "reviewer.leaderboardOptIn": true }, { projection: { _id: 0, userId: 1 } })
        .toArray()).map((u) => u.userId),
    );
    const visible = rows.filter((r) => optedIn.has(r._id)).slice(0, REVIEWS.LEADERBOARD_SIZE);
    const profiles = await this.publicProfiles(visible.map((r) => r._id));
    return {
      weekStart: weekStart.toISOString(),
      items: visible.map((row, index) => {
        const profile = profiles.get(row._id) || {};
        return {
          rank: index + 1,
          name: profile.name || "SC2 Player",
          profileHref: profile.profileHref || null,
          verified: profile.verified || null,
          flair: profile.flair || null,
          points: row.points,
          helpful: row.helpful,
          best: row.best,
        };
      }),
    };
  }

  /**
   * Reviewer section for a PUBLIC /p/:handle profile. Null until the
   * user has reviewed at least once.
   *
   * @param {string} userId
   */
  async publicSection(userId) {
    const user = await this.db.users.findOne({ userId }, { projection: { _id: 0, reviewer: 1 } });
    const stats = reviewerStats(user?.reviewer);
    if (stats.reviews === 0 && stats.karma === 0) return null;
    const requestIds = await this.db.reviewComments.distinct("requestId", {
      authorId: userId,
      parentId: null,
      isAskerComment: { $ne: true },
      status: "visible",
    });
    const matchups = await this.db.reviewRequests
      .aggregate([
        { $match: { _id: { $in: requestIds.slice(0, 2000) }, status: { $in: ["open", "answered", "closed"] }, hidden: { $ne: true } } },
        { $group: { _id: "$matchup", count: { $sum: 1 } } },
        { $match: { _id: { $type: "string" } } },
        { $sort: { count: -1, _id: 1 } },
      ])
      .toArray();
    const verified = publicVerification(user?.reviewer?.verified);
    return {
      karma: stats.karma,
      reviews: stats.reviews,
      helpful: stats.helpful,
      bestAnswers: stats.best,
      badges: badgesFor(stats),
      flair: flairFor(stats, verified),
      verified,
      matchupsReviewed: matchups.map((m) => ({ matchup: m._id, count: m.count })),
    };
  }
}

/** @param {Record<string, any> | undefined | null} raw @returns {ReviewerStats} */
function reviewerStats(raw) {
  const n = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    karma: n(raw?.karma),
    helpful: n(raw?.helpful),
    best: n(raw?.best),
    upvotes: n(raw?.upvotes),
    reviews: n(raw?.reviews),
    removed: n(raw?.removed),
  };
}

/** @param {ReviewerStats} stats */
function badgesFor(stats) {
  return BADGES.filter((b) => b.test(stats)).map((b) => ({ key: b.key, label: b.label }));
}

/**
 * "Masters Mentor" — verified league flair on the reviewer's top badge.
 *
 * @param {ReviewerStats} stats
 * @param {{band: {id: number, label: string} | null} | null} verified
 */
function flairFor(stats, verified) {
  const title = stats.helpful >= 50 ? "Mentor" : stats.best >= 10 ? "Top Reviewer" : null;
  if (!title) return null;
  if (!verified?.band) return title;
  // The league id 5 label is "Master" everywhere in the data; the
  // community's name for it in a title is "Masters".
  const league = verified.band.id === 5 ? "Masters" : verified.band.label;
  return `${league} ${title}`;
}

/**
 * Only the public facts: band, race and rounded MMR, plus each region's
 * band and race (no per-region MMR).
 *
 * @param {Record<string, any> | undefined | null} raw
 */
function publicVerification(raw) {
  if (!raw || !raw.band) return null;
  const band = bandFromId(raw.band.id);
  if (!band) return null;
  return {
    band: { id: band.id, label: band.label },
    race: normalizeRace(raw.race),
    mmr: typeof raw.mmr === "number" ? raw.mmr : null,
    regions: publicRegions(raw.regions),
  };
}

/**
 * Community's "named by default" idiom: display name, then the name half
 * of the BattleTag. An internal/Clerk id is never turned into a name.
 *
 * @param {Record<string, any>} user
 */
function publicName(user) {
  const display = typeof user.displayName === "string" ? cleanDisplayName(user.displayName).slice(0, 60) : "";
  if (display) return display;
  const tag = typeof user.battleTag === "string" ? cleanDisplayName(user.battleTag.split("#")[0]).slice(0, 60) : "";
  return tag || "SC2 Player";
}

/** @param {Date} now */
function isoWeekStart(now) {
  const day = now.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (day - 1));
  return start;
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

module.exports = {
  ReviewerReputationService,
  VERIFICATION_VERSION,
  BADGES,
  badgesFor,
  flairFor,
  publicName,
  publicVerification,
  reviewerStats,
  isoWeekStart,
};
