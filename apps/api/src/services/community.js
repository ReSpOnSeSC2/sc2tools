"use strict";

const crypto = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

const K_ANONYMITY_THRESHOLD = 5;

/**
 * Projection used for every public listing/detail of a community
 * build. Centralised so list/detail/author-aggregate stay in sync —
 * anything new added to a build doc is automatically excluded from
 * public responses unless explicitly opted in here.
 */
const PUBLIC_PROJECTION = Object.freeze({
  _id: 0,
  slug: 1,
  ownerUserId: 1,
  title: 1,
  description: 1,
  matchup: 1,
  authorName: 1,
  votes: 1,
  publishedAt: 1,
  updatedAt: 1,
  build: 1,
});

/**
 * @param {Record<string, number>} counts
 * @param {number} total
 * @param {number} threshold — minimum share to qualify as dominant
 * @returns {string | null}
 */
function pickDominant(counts, total, threshold) {
  let best = "";
  let bestN = 0;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  if (!best || total === 0) return null;
  return bestN / total >= threshold ? best : null;
}

/**
 * @param {Record<string, number>} counts
 * @returns {string | null}
 */
function pickTop(counts) {
  let best = "";
  let bestN = 0;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best || null;
}

/**
 * Community service.
 *
 * Two public-read entities:
 *   1. communityBuilds — user-published custom builds, slug-addressed,
 *      voted on, reportable.
 *   2. aggregated opponent profiles — derived from `games` across all
 *      users. K-anonymity gated: we only surface a row if at least
 *      K_ANONYMITY_THRESHOLD distinct users have faced that pulseId.
 *
 * Plus a moderation queue: communityReports holds user-flag records
 * resolved by an admin via the Clerk role check.
 */
class CommunityService {
  /**
   * @param {import('../db/connect').DbContext} db
   */
  constructor(db) {
    this.db = db;
  }

  // ── Builds ──────────────────────────────────────────────────────

  /**
   * Publish (or re-publish) a custom build to the community. Keyed on
   * (ownerUserId, sourceSlug) so it's idempotent per private build —
   * re-publishing updates the public copy in place.
   *
   * Re-publish preserves everything the public has already interacted
   * with: the public ``slug`` (stable shareable URL), the ``votes``
   * tally, and the original ``publishedAt`` date. Only the snapshot and
   * any author-supplied metadata change. (The previous implementation
   * regenerated the slug and reset votes to 0 on every save, which broke
   * shared links and wiped vote counts whenever an author edited a
   * build they'd already published.)
   *
   * The published ``build`` is a sanitised snapshot: private fields
   * (personal notes, source-replay id, internal ids, the owner's
   * userId) are stripped via {@link publicBuildSnapshot} so the public
   * copy honours the "personal notes / source replays stay private"
   * promise shown at publish time.
   *
   * @param {string} userId
   * @param {string} userSlug — the private build's slug
   * @param {{title?: string, description?: string, authorName?: string}} meta
   * @returns {Promise<{slug: string, created: boolean}>}
   */
  async publish(userId, userSlug, meta) {
    const priv = await this.db.customBuilds.findOne({
      userId,
      slug: userSlug,
      deletedAt: { $exists: false },
    });
    if (!priv) {
      const err = new Error("build_not_found");
      /** @type {any} */ (err).status = 404;
      throw err;
    }
    const existing = await this.db.communityBuilds.findOne({
      ownerUserId: userId,
      sourceSlug: userSlug,
    });
    const now = new Date();
    // Preserve the public slug across re-publishes so shared links keep
    // working; only mint a new one for a first-time publish.
    const slug = existing
      ? existing.slug
      : await this._uniqueSlug(meta.title || priv.name || userSlug);
    const title =
      meta.title || (existing && existing.title) || priv.name || userSlug;
    // Only overwrite description / authorName when the caller actually
    // supplied a value, so the lightweight "Share with community" toggle
    // (which sends neither) never wipes metadata the author entered
    // through the richer publish dialog.
    const description =
      meta.description || (existing && existing.description) || "";
    const authorName =
      meta.authorName || (existing && existing.authorName) || "";
    /** @type {Record<string, any>} */
    const doc = {
      slug,
      ownerUserId: userId,
      sourceSlug: userSlug,
      title,
      description,
      authorName,
      matchup: priv.matchup || matchupFromRaces(priv.race, priv.vsRace),
      build: publicBuildSnapshot(priv),
      votes: existing && Number.isFinite(existing.votes) ? existing.votes : 0,
      publishedAt: (existing && existing.publishedAt) || now,
      updatedAt: now,
      removed: false,
    };
    stampVersion(doc, COLLECTIONS.COMMUNITY_BUILDS);
    await this.db.communityBuilds.updateOne(
      { ownerUserId: userId, sourceSlug: userSlug },
      { $set: doc, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    // Mirror published state onto the private doc so the "Published"
    // badge + the editor's share toggle reflect reality across every
    // publish entry point (this dialog, the save-time toggle, forks).
    await this._setPrivateIsPublic(userId, userSlug, true);
    return { slug, created: !existing };
  }

  /**
   * Unpublish by the PRIVATE build slug (sourceSlug). Used by the
   * save-time "Share with community" toggle when an author flips
   * sharing back off — the editor knows only the private slug, not the
   * public one. Soft-removes the public copy; the doc (with its slug +
   * votes) is retained so re-publishing later restores the same
   * listing. No-op when the build was never published.
   *
   * @param {string} userId
   * @param {string} sourceSlug
   * @returns {Promise<boolean>} true when a live public copy was removed
   */
  async unpublishBySource(userId, sourceSlug) {
    const res = await this.db.communityBuilds.updateOne(
      { ownerUserId: userId, sourceSlug, removed: { $ne: true } },
      {
        $set: {
          removed: true,
          removedAt: new Date(),
          removedBy: userId,
          removalReason: "owner_unpublish",
        },
      },
    );
    // Keep the private doc's badge in sync even when nothing was live to
    // remove — the author's intent is "not shared".
    await this._setPrivateIsPublic(userId, sourceSlug, false);
    return res.matchedCount > 0;
  }

  /**
   * Set `isPublic` on the owner's private custom-build doc. Best-effort
   * mirror of community state; skips soft-deleted docs and never throws
   * on a missing build (the community write is the source of truth).
   *
   * @private
   * @param {string} userId
   * @param {string} sourceSlug
   * @param {boolean} isPublic
   */
  async _setPrivateIsPublic(userId, sourceSlug, isPublic) {
    await this.db.customBuilds.updateOne(
      { userId, slug: sourceSlug, deletedAt: { $exists: false } },
      { $set: { isPublic: !!isPublic, updatedAt: new Date() } },
    );
  }

  /**
   * Unpublish (soft) by setting removed=true. The owner OR an admin
   * can call this; admin path adds a moderation note in the report.
   *
   * @param {string} userId
   * @param {string} slug
   * @param {{adminUserId?: string, reason?: string}} [opts]
   */
  async unpublish(userId, slug, opts = {}) {
    const filter = opts.adminUserId
      ? { slug }
      : { slug, ownerUserId: userId };
    const res = await this.db.communityBuilds.updateOne(filter, {
      $set: {
        removed: true,
        removedAt: new Date(),
        removedBy: opts.adminUserId || userId,
        removalReason: opts.reason || "owner_unpublish",
      },
    });
    if (res.matchedCount === 0) {
      const err = new Error("not_found");
      /** @type {any} */ (err).status = 404;
      throw err;
    }
  }

  /**
   * Public list — only non-removed builds, optionally filtered by
   * matchup or a free-text query. Sortable by top votes, newest, or
   * "controversial" (high engagement, near-50/50 vote split).
   *
   * `ownerUserId` is exposed so the frontend can link author chips to
   * `/community/authors/:userId`. It is our internal UUID, not the
   * Clerk id, so it's safe to surface publicly (decoupled from auth
   * provider, see UsersService.ensureFromClerk).
   *
   * @param {{
   *   matchup?: string,
   *   limit?: number,
   *   offset?: number,
   *   sort?: 'top' | 'new' | 'controversial',
   *   search?: string,
   * }} opts
   */
  async listPublic(opts = {}) {
    const filter = /** @type {Record<string, any>} */ ({ removed: false });
    if (opts.matchup) filter.matchup = opts.matchup;
    if (opts.search) {
      const escaped = String(opts.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "i");
      filter.$or = [
        { title: re },
        { description: re },
        { authorName: re },
      ];
    }
    const limit = Math.min(opts.limit || 30, 100);
    const offset = Math.max(0, Number(opts.offset) || 0);
    const sortKey = opts.sort || "top";
    /** @type {Record<string, 1 | -1>} */
    let sort;
    switch (sortKey) {
      case "new":
        sort = { publishedAt: -1, votes: -1 };
        break;
      case "controversial":
        // Controversial: lots of votes either way. We approximate by
        // ordering on the sum of upvotes + downvotes desc. The
        // pipeline path computes the sum field on the fly.
        return this._listControversial(filter, { limit, offset });
      case "top":
      default:
        sort = { votes: -1, publishedAt: -1 };
        break;
    }
    const cursor = this.db.communityBuilds
      .find(filter, { projection: PUBLIC_PROJECTION })
      .sort(sort)
      .skip(offset)
      .limit(limit + 1); // Fetch one extra to know whether more exist.
    const rows = await cursor.toArray();
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const total = await this.db.communityBuilds.countDocuments(filter);
    return { items, hasMore, total, offset, limit };
  }

  /**
   * Balanced "top-N per matchup" listing used by the Arcade Stock
   * Market to build a universe of builds that spans every matchup.
   * The default `listPublic` (sort=top, global) skews to whichever
   * race dominates vote counts — for a Protoss-heavy community that
   * collapses the universe to PvX, hiding ZvX/TvX entirely. This
   * method groups by matchup and keeps the top `perMatchup` builds in
   * each bucket so every matchup gets representation.
   *
   * One Mongo aggregation, served by the
   * `{matchup, removed, votes: -1}` index. The empty-string matchup
   * (legacy unclassified rows) gets its own bucket so those builds
   * still surface.
   *
   * @param {{ perMatchup?: number, totalCap?: number }} [opts]
   * @returns {Promise<{ items: object[] }>}
   */
  async listArcadeUniverse(opts = {}) {
    const perMatchup = Math.min(Math.max(1, Number(opts.perMatchup) || 12), 50);
    const totalCap = Math.min(Math.max(1, Number(opts.totalCap) || 200), 500);
    const items = await this.db.communityBuilds
      .aggregate([
        { $match: { removed: false } },
        { $sort: { votes: -1, publishedAt: -1 } },
        {
          $group: {
            _id: { $ifNull: ["$matchup", ""] },
            items: {
              $push: {
                slug: "$slug",
                ownerUserId: "$ownerUserId",
                title: "$title",
                description: "$description",
                matchup: "$matchup",
                authorName: "$authorName",
                votes: "$votes",
                publishedAt: "$publishedAt",
                updatedAt: "$updatedAt",
                build: "$build",
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            matchup: "$_id",
            items: { $slice: ["$items", perMatchup] },
          },
        },
        { $unwind: "$items" },
        { $replaceRoot: { newRoot: "$items" } },
        { $sort: { matchup: 1, votes: -1, publishedAt: -1 } },
        { $limit: totalCap },
      ])
      .toArray();
    return { items };
  }

  /**
   * @param {Record<string, any>} filter
   * @param {{limit: number, offset: number}} page
   */
  async _listControversial(filter, page) {
    const items = await this.db.communityBuilds
      .aggregate([
        { $match: filter },
        {
          $addFields: {
            engagement: {
              $add: [
                { $size: { $ifNull: ["$upvotes", []] } },
                { $size: { $ifNull: ["$downvotes", []] } },
              ],
            },
          },
        },
        { $sort: { engagement: -1, publishedAt: -1 } },
        { $skip: page.offset },
        { $limit: page.limit + 1 },
        { $project: { ...PUBLIC_PROJECTION, engagement: 0 } },
      ])
      .toArray();
    const hasMore = items.length > page.limit;
    const total = await this.db.communityBuilds.countDocuments(filter);
    return {
      items: items.slice(0, page.limit),
      hasMore,
      total,
      offset: page.offset,
      limit: page.limit,
    };
  }

  /**
   * Public detail — full build content. 404s when removed.
   * Exposes `ownerUserId` (our internal UUID) so the frontend can link
   * to the author profile page.
   *
   * @param {string} slug
   */
  async getPublic(slug) {
    const row = await this.db.communityBuilds.findOne(
      { slug, removed: false },
      {
        // Strip Mongo-internal fields and the per-user vote arrays.
        // ownerUserId is intentionally exposed.
        projection: { _id: 0, upvotes: 0, downvotes: 0 },
      },
    );
    return row;
  }

  /**
   * Public author profile aggregate. Returns null when the author has
   * no published builds OR when none of their builds carry a public
   * `authorName` — that's the implicit "no public profile" opt-out.
   * Users who never declare a display name on a publish stay private.
   *
   * @param {string} userId — internal UUID (not Clerk id)
   * @returns {Promise<{
   *   userId: string,
   *   displayName: string,
   *   joinedAt: Date | null,
   *   builds: object[],
   *   totalBuilds: number,
   *   totalVotes: number,
   *   primaryRace: string | null,
   *   topMatchup: string | null,
   *   topBuild: object | null,
   *   recent: object[],
   * } | null>}
   */
  async getAuthor(userId) {
    if (!userId) return null;
    const builds = await this.db.communityBuilds
      .find(
        { ownerUserId: userId, removed: false },
        { projection: PUBLIC_PROJECTION },
      )
      .sort({ publishedAt: -1 })
      .toArray();
    if (builds.length === 0) return null;
    // Anonymization gate: at least one build must have a non-empty
    // authorName for the profile to be public. Users who publish
    // without a display name stay private (404 from the route).
    const named = builds.filter(
      (b) => typeof b.authorName === "string" && b.authorName.trim().length > 0,
    );
    if (named.length === 0) return null;
    // Most-recent declared authorName wins as the canonical display.
    const displayName = named[0].authorName.trim();
    const totalVotes = builds.reduce(
      (acc, b) => acc + (Number.isFinite(b.votes) ? b.votes : 0),
      0,
    );
    /** @type {Record<string, number>} */
    const raceCounts = {};
    /** @type {Record<string, number>} */
    const matchupCounts = {};
    for (const b of builds) {
      const r = b.build?.race;
      if (r) raceCounts[r] = (raceCounts[r] || 0) + 1;
      if (b.matchup) matchupCounts[b.matchup] = (matchupCounts[b.matchup] || 0) + 1;
    }
    const primaryRace = pickDominant(raceCounts, builds.length, 0.6);
    const topMatchup = pickTop(matchupCounts);
    const topBuild = builds.reduce((best, cur) => {
      if (!best) return cur;
      return (cur.votes ?? 0) > (best.votes ?? 0) ? cur : best;
    }, /** @type {any} */ (null));
    const joinedAt = builds.length
      ? builds.reduce((earliest, b) => {
          const t = b.publishedAt ? new Date(b.publishedAt).getTime() : NaN;
          if (!Number.isFinite(t)) return earliest;
          if (earliest == null || t < earliest) return t;
          return earliest;
        }, /** @type {number | null} */ (null))
      : null;
    return {
      userId,
      displayName,
      joinedAt: joinedAt != null ? new Date(joinedAt) : null,
      builds,
      totalBuilds: builds.length,
      totalVotes,
      primaryRace,
      topMatchup,
      topBuild,
      recent: builds.slice(0, 5),
    };
  }

  /**
   * @param {string} userId
   * @param {string} slug
   * @param {1 | -1} delta
   */
  async vote(userId, slug, delta) {
    if (delta !== 1 && delta !== -1) {
      const err = new Error("delta must be ±1");
      /** @type {any} */ (err).status = 400;
      throw err;
    }
    // We store one vote per (userId, slug) by stashing the vote inside
    // the build doc via $addToSet; rolling our own vote table is overkill
    // for the volumes we expect.
    const arr = delta === 1 ? "upvotes" : "downvotes";
    const opposite = delta === 1 ? "downvotes" : "upvotes";
    await this.db.communityBuilds.updateOne(
      { slug, removed: false },
      {
        $addToSet: { [arr]: userId },
        $pull: { [opposite]: userId },
      },
    );
    // Refresh the cached `votes` count.
    const row = await this.db.communityBuilds.findOne(
      { slug },
      { projection: { upvotes: 1, downvotes: 1 } },
    );
    if (row) {
      const u = Array.isArray(row.upvotes) ? row.upvotes.length : 0;
      const d = Array.isArray(row.downvotes) ? row.downvotes.length : 0;
      await this.db.communityBuilds.updateOne(
        { slug },
        { $set: { votes: u - d } },
      );
    }
  }

  // ── K-anonymous opponent profiles ────────────────────────────────

  /**
   * Compute aggregate stats for one pulseId across ALL users. Returns
   * null if fewer than K_ANONYMITY_THRESHOLD distinct users have faced
   * this opponent — public exposure of single-user data is a privacy
   * leak (you'd be able to recover individual battle tags by cross-
   * referencing).
   *
   * @param {string} pulseId
   */
  async aggregateOpponent(pulseId) {
    // Discover the canonical SC2Pulse character id for this toon
    // handle from any opponents row that's seen it. If a player
    // ever rebound their Battle.net account, two distinct toon
    // handles may both map to the same pulseCharacterId; we want
    // the cross-toon games to appear in the public aggregate so
    // the k-anonymous profile reflects the same player's full
    // public footprint. ``distinct`` returns at most one id per
    // input toon — opponents.pulseId is unique-per-user, so we
    // grab any user's row and read its character id off.
    const charIdRow = await this.db.opponents.findOne(
      {
        pulseId,
        pulseCharacterId: { $type: "string", $ne: "" },
      },
      { projection: { pulseCharacterId: 1 } },
    );
    const pulseCharacterId = charIdRow && typeof charIdRow.pulseCharacterId === "string"
      ? charIdRow.pulseCharacterId
      : null;
    /** @type {Record<string, any>} */
    const filter = pulseCharacterId
      ? {
          $or: [
            { "opponent.pulseId": pulseId },
            { "opponent.pulseCharacterId": pulseCharacterId },
          ],
        }
      : { "opponent.pulseId": pulseId };
    const games = await this.db.games
      .find(filter, {
        projection: {
          userId: 1,
          result: 1,
          map: 1,
          "opponent.race": 1,
          "opponent.strategy": 1,
          "opponent.opening": 1,
          _id: 0,
        },
      })
      .toArray();
    const distinctUsers = new Set(games.map((g) => g.userId));
    if (distinctUsers.size < K_ANONYMITY_THRESHOLD) {
      return null;
    }
    let wins = 0;
    let losses = 0;
    /** @type {Record<string, number>} */
    const openings = {};
    /** @type {Record<string, number>} */
    const strategies = {};
    /** @type {Record<string, {wins: number, losses: number}>} */
    const byMap = {};
    /** @type {string|undefined} */
    let race = undefined;
    for (const g of games) {
      // From the opponent's perspective: their wins are our losses.
      if (g.result === "Defeat") wins += 1;
      if (g.result === "Victory") losses += 1;
      if (!race && g.opponent?.race) race = g.opponent.race;
      const op = g.opponent?.opening;
      if (op) openings[op] = (openings[op] || 0) + 1;
      const st = g.opponent?.strategy;
      if (st) strategies[st] = (strategies[st] || 0) + 1;
      if (g.map) {
        if (!byMap[g.map]) byMap[g.map] = { wins: 0, losses: 0 };
        if (g.result === "Defeat") byMap[g.map].wins += 1;
        if (g.result === "Victory") byMap[g.map].losses += 1;
      }
    }
    const total = wins + losses;
    return {
      pulseId,
      race,
      contributors: distinctUsers.size,
      games: games.length,
      wins,
      losses,
      winRate: total > 0 ? wins / total : 0,
      openings,
      strategies,
      byMap,
    };
  }

  // ── Moderation queue ─────────────────────────────────────────────

  /**
   * @param {string} userId — reporter
   * @param {{targetType: 'build'|'opponent', targetId: string, reason: string, note?: string}} input
   */
  async report(userId, input) {
    if (!["build", "opponent"].includes(input.targetType)) {
      const err = new Error("targetType must be build|opponent");
      /** @type {any} */ (err).status = 400;
      throw err;
    }
    const reason = String(input.reason || "").slice(0, 80);
    if (!reason) {
      const err = new Error("reason required");
      /** @type {any} */ (err).status = 400;
      throw err;
    }
    await this.db.communityReports.insertOne(
      stampVersion(
        {
          id: crypto.randomUUID(),
          reporterUserId: userId,
          targetType: input.targetType,
          targetId: String(input.targetId),
          reason,
          note: String(input.note || "").slice(0, 1000),
          createdAt: new Date(),
          resolvedAt: null,
          resolution: null,
        },
        COLLECTIONS.COMMUNITY_REPORTS,
      ),
    );
  }

  /** @returns {Promise<{items: object[]}>} */
  async listReports() {
    const items = await this.db.communityReports
      .find({ resolvedAt: null }, { projection: { _id: 0 } })
      .sort({ createdAt: 1 })
      .limit(100)
      .toArray();
    return { items };
  }

  /**
   * @param {string} adminUserId
   * @param {string} reportId
   * @param {{action: 'dismiss'|'remove', note?: string}} input
   */
  async resolveReport(adminUserId, reportId, input) {
    const report = await this.db.communityReports.findOne({ id: reportId });
    if (!report) {
      const err = new Error("report_not_found");
      /** @type {any} */ (err).status = 404;
      throw err;
    }
    if (input.action === "remove" && report.targetType === "build") {
      await this.unpublish("admin", report.targetId, {
        adminUserId,
        reason: input.note || "moderator_action",
      });
    }
    await this.db.communityReports.updateOne(
      { id: reportId },
      {
        $set: {
          resolvedAt: new Date(),
          resolvedBy: adminUserId,
          resolution: input.action,
          note: input.note || null,
        },
      },
    );
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * Slug = title kebab-cased + 6 random hex chars to keep it unique
   * even when titles collide. We don't try to reuse old slugs because
   * the public URL is stable per publish.
   *
   * @param {string} title
   * @returns {Promise<string>}
   */
  async _uniqueSlug(title) {
    const base = String(title)
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "build";
    for (let i = 0; i < 5; i++) {
      const suffix = crypto.randomBytes(3).toString("hex");
      const candidate = `${base}-${suffix}`;
      const exists = await this.db.communityBuilds.findOne(
        { slug: candidate },
        { projection: { _id: 1 } },
      );
      if (!exists) return candidate;
    }
    // Fallback — astronomically unlikely.
    return `build-${crypto.randomBytes(8).toString("hex")}`;
  }
}

/**
 * Fields from a private custom-build doc that are safe to expose on the
 * public community copy. A whitelist (not a blacklist) so a newly-added
 * private field can never silently leak into the public snapshot:
 * anything not listed here is dropped. Notably absent — ``notes``
 * (personal scouting notes), ``sourceGameId`` (links to a private
 * replay), ``userId`` / ``_id`` (internal), and the share/visibility
 * flags (``isPublic`` / ``shareWithCommunity``).
 */
const PUBLIC_BUILD_FIELDS = Object.freeze([
  "slug",
  "name",
  "race",
  "vsRace",
  "matchup",
  "description",
  "signature",
  "rules",
  "schemaVersion",
  "skillLevel",
  "winConditions",
  "losesTo",
  "transitionsInto",
  "perspective",
  "steps",
]);

/**
 * Build the public snapshot stored under a community build's ``build``
 * field. See {@link PUBLIC_BUILD_FIELDS}.
 *
 * @param {Record<string, any>} priv
 * @returns {Record<string, any>}
 */
function publicBuildSnapshot(priv) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!priv || typeof priv !== "object") return out;
  for (const key of PUBLIC_BUILD_FIELDS) {
    if (priv[key] !== undefined) out[key] = priv[key];
  }
  return out;
}

/**
 * Derive a "PvT"-style matchup tag from a build's own race + target
 * race. v3 custom builds store ``race`` / ``vsRace`` rather than a
 * ``matchup`` string; without this the community listing's matchup
 * facet would be blank for every editor-authored build. Returns "" when
 * either side isn't a concrete race (e.g. vsRace "Any" or "Random"),
 * matching how the matchup filter treats unclassified rows.
 *
 * @param {string|undefined|null} race
 * @param {string|undefined|null} vsRace
 * @returns {string}
 */
function matchupFromRaces(race, vsRace) {
  const a = raceLetter(race);
  const b = raceLetter(vsRace);
  if (!a || !b) return "";
  return `${a}v${b}`;
}

/**
 * First letter of a concrete race (P/T/Z), or "" for
 * Random / Any / unknown — those don't define a matchup bucket.
 *
 * @param {string|undefined|null} race
 * @returns {string}
 */
function raceLetter(race) {
  if (typeof race !== "string") return "";
  const c = race.charAt(0).toUpperCase();
  return c === "P" || c === "T" || c === "Z" ? c : "";
}

module.exports = { CommunityService, K_ANONYMITY_THRESHOLD };
