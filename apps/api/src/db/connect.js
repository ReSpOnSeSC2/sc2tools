"use strict";

const { MongoClient } = require("mongodb");
const { COLLECTIONS, TIMEOUTS } = require("../config/constants");

/**
 * @typedef {{
 *   client: MongoClient,
 *   db: import('mongodb').Db,
 *   users: import('mongodb').Collection,
 *   profiles: import('mongodb').Collection,
 *   opponents: import('mongodb').Collection,
 *   games: import('mongodb').Collection,
 *   gameDetails: import('mongodb').Collection,
 *   customBuilds: import('mongodb').Collection,
 *   devicePairings: import('mongodb').Collection,
 *   deviceTokens: import('mongodb').Collection,
 *   overlayTokens: import('mongodb').Collection,
 *   mlModels: import('mongodb').Collection,
 *   mlJobs: import('mongodb').Collection,
 *   importJobs: import('mongodb').Collection,
 *   macroJobs: import('mongodb').Collection,
 *   agentReleases: import('mongodb').Collection,
 *   communityBuilds: import('mongodb').Collection,
 *   communityReports: import('mongodb').Collection,
 *   userBackups: import('mongodb').Collection,
 *   arcadeLeaderboard: import('mongodb').Collection,
 *   close: () => Promise<void>,
 * }} DbContext
 */

/**
 * Open the MongoDB connection and return collection handles.
 *
 * @param {{ uri: string, dbName: string }} opts
 * @returns {Promise<DbContext>}
 *
 * Example:
 *   const ctx = await connect({ uri: cfg.mongoUri, dbName: cfg.mongoDb });
 */
async function connect({ uri, dbName }) {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: TIMEOUTS.MONGO_CONNECT_MS,
    socketTimeoutMS: TIMEOUTS.MONGO_SOCKET_MS,
    retryWrites: true,
  });
  await client.connect();
  const db = client.db(dbName);
  const ctx = {
    client,
    db,
    users: db.collection(COLLECTIONS.USERS),
    profiles: db.collection(COLLECTIONS.PROFILES),
    opponents: db.collection(COLLECTIONS.OPPONENTS),
    games: db.collection(COLLECTIONS.GAMES),
    gameDetails: db.collection(COLLECTIONS.GAME_DETAILS),
    customBuilds: db.collection(COLLECTIONS.CUSTOM_BUILDS),
    devicePairings: db.collection(COLLECTIONS.DEVICE_PAIRINGS),
    deviceTokens: db.collection(COLLECTIONS.DEVICE_TOKENS),
    overlayTokens: db.collection(COLLECTIONS.OVERLAY_TOKENS),
    mlModels: db.collection(COLLECTIONS.ML_MODELS),
    mlJobs: db.collection(COLLECTIONS.ML_JOBS),
    importJobs: db.collection(COLLECTIONS.IMPORT_JOBS),
    macroJobs: db.collection(COLLECTIONS.MACRO_JOBS),
    agentReleases: db.collection(COLLECTIONS.AGENT_RELEASES),
    communityBuilds: db.collection(COLLECTIONS.COMMUNITY_BUILDS),
    communityReports: db.collection(COLLECTIONS.COMMUNITY_REPORTS),
    userBackups: db.collection(COLLECTIONS.USER_BACKUPS),
    arcadeLeaderboard: db.collection(COLLECTIONS.ARCADE_LEADERBOARD),
    close: () => client.close(),
  };
  await ensureIndexes(ctx);
  return ctx;
}

/**
 * Idempotent index setup. Safe to call on every boot — Mongo skips
 * indexes that already exist with the same spec.
 *
 * Hot queries we index for:
 *   - opponents browse:   {userId, pulseId}
 *   - games by date:      {userId, date}
 *   - games by opponent:  {opponent.pulseId, userId, date}
 *   - games dedupe:       {userId, gameId}  (unique)
 *   - device pairings:    {code} (unique, TTL)
 *   - device tokens:      {tokenHash} (unique)
 *   - overlay tokens:     {token} (unique)
 *
 * @param {DbContext} ctx
 */
async function ensureIndexes(ctx) {
  await ctx.users.createIndex({ clerkUserId: 1 }, { unique: true });

  await ctx.opponents.createIndex({ userId: 1, pulseId: 1 }, { unique: true });
  await ctx.opponents.createIndex({ userId: 1, lastSeen: -1 });

  await ctx.games.createIndex({ userId: 1, gameId: 1 }, { unique: true });
  await ctx.games.createIndex({ userId: 1, date: -1 });
  // Opponent lookup uses the nested ``opponent.pulseId`` path
  // (services/overlayLive.js, services/community.js, services/gdpr.js,
  // routes/games.js). Field order matches Atlas Performance Advisor
  // recommendations sized against real query targeting metrics.
  await ctx.games.createIndex({
    "opponent.pulseId": 1,
    userId: 1,
    date: -1,
  });
  // Cross-toon opponent merge. The H2H lookup, opponent profile, and
  // public k-anon aggregate query games by either ``pulseId`` (raw
  // toon handle) OR ``pulseCharacterId`` (canonical SC2Pulse id) so
  // a Battle.net rebind that rotated the toon doesn't drop the
  // pre-rebind games out of the result. The pulseId branch hits the
  // index above; this index serves the pulseCharacterId branch.
  // Sparse so unresolved rows (the common case for opponents the
  // backfill cron hasn't reached yet) don't cost storage.
  await ctx.games.createIndex(
    {
      "opponent.pulseCharacterId": 1,
      userId: 1,
      date: -1,
    },
    { sparse: true },
  );
  // Covers _recentGamesForOpponent in services/overlayLive.js, which
  // filters on userId + opponent.pulseId + myRace + opponent.race with
  // an optional $ne gameId. Runs on every overlay tick.
  await ctx.games.createIndex({
    myRace: 1,
    "opponent.pulseId": 1,
    "opponent.race": 1,
    userId: 1,
    date: -1,
    gameId: 1,
  });

  // Game-detail rows live in their own collection so the slim
  // ``games`` collection stays cheap to scan (Recent Games table,
  // aggregations, opponent profile). Detail rows are looked up by the
  // SAME (userId, gameId) tuple — same unique index shape — and only
  // the per-game inspector / macro drilldown / spatial endpoints
  // touch them. See ``services/gameDetails.js``.
  await ctx.gameDetails.createIndex(
    { userId: 1, gameId: 1 },
    { unique: true },
  );
  // ``date`` is duplicated onto the detail row so the spatial
  // aggregation (``services/spatial.js``) can keep filtering by date
  // window without a $lookup back to games.
  await ctx.gameDetails.createIndex({ userId: 1, date: -1 });

  await ctx.customBuilds.createIndex({ userId: 1, slug: 1 }, { unique: true });
  await ctx.customBuilds.createIndex({ userId: 1, updatedAt: -1 });

  await ctx.devicePairings.createIndex({ code: 1 }, { unique: true });
  await ctx.devicePairings.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  await ctx.deviceTokens.createIndex({ tokenHash: 1 }, { unique: true });
  await ctx.deviceTokens.createIndex({ userId: 1, lastSeenAt: -1 });

  await ctx.overlayTokens.createIndex({ token: 1 }, { unique: true });
  await ctx.overlayTokens.createIndex({ userId: 1, createdAt: -1 });

  // Analytics hot-paths added by the C-bucket port. These accelerate
  // the $facet aggregations the AggregationsService and BuildsService
  // run on every tab change in the SPA.
  await ctx.games.createIndex({ userId: 1, myBuild: 1, date: -1 });
  await ctx.games.createIndex({ userId: 1, "opponent.strategy": 1 });
  await ctx.games.createIndex({ userId: 1, map: 1, date: -1 });

  await ctx.mlModels.createIndex({ userId: 1, kind: 1 }, { unique: true });
  await ctx.mlJobs.createIndex({ userId: 1, createdAt: -1 });

  await ctx.importJobs.createIndex({ userId: 1, createdAt: -1 });
  await ctx.macroJobs.createIndex({ userId: 1, createdAt: -1 });

  await ctx.agentReleases.createIndex({ channel: 1, version: 1 }, { unique: true });
  await ctx.agentReleases.createIndex({ channel: 1, publishedAt: -1 });

  // Community indexes — slug is the public URL key. {removed: 1, votes: -1}
  // serves "top published" lists; {ownerUserId, slug} keeps per-author
  // dedupe + the publish/unpublish toggle.
  await ctx.communityBuilds.createIndex({ slug: 1 }, { unique: true });
  await ctx.communityBuilds.createIndex({ ownerUserId: 1, slug: 1 });
  await ctx.communityBuilds.createIndex({ removed: 1, votes: -1 });
  await ctx.communityBuilds.createIndex({ matchup: 1, removed: 1, votes: -1 });

  await ctx.communityReports.createIndex({ targetType: 1, targetId: 1 });
  await ctx.communityReports.createIndex({ resolvedAt: 1, createdAt: -1 });

  await ctx.userBackups.createIndex({ userId: 1, createdAt: -1 });
  await ctx.userBackups.createIndex({ id: 1 }, { unique: true });

  // Arcade Stock Market weekly P&L leaderboard. One row per
  // (userId, weekKey) — upserted via the opt-in submit endpoint — and
  // listed per-week sorted by pnlPct desc with updatedAt as the
  // stable tie-breaker.
  await ctx.arcadeLeaderboard.createIndex(
    { userId: 1, weekKey: 1 },
    { unique: true },
  );
  await ctx.arcadeLeaderboard.createIndex({ weekKey: 1, pnlPct: -1, updatedAt: 1 });
}

module.exports = { connect, ensureIndexes };
