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
 *   multichatStudio: import('mongodb').Collection,
 *   mlModels: import('mongodb').Collection,
 *   mlJobs: import('mongodb').Collection,
 *   importJobs: import('mongodb').Collection,
 *   macroJobs: import('mongodb').Collection,
 *   agentReleases: import('mongodb').Collection,
 *   communityBuilds: import('mongodb').Collection,
 *   communityReports: import('mongodb').Collection,
 *   userBackups: import('mongodb').Collection,
 *   arcadeLeaderboard: import('mongodb').Collection,
 *   adminEvents: import('mongodb').Collection,
 *   pulseAccounts: import('mongodb').Collection,
 *   close: () => Promise<void>,
 * }} DbContext
 */

/**
 * Open the MongoDB connection and return collection handles.
 *
 * @param {{ uri: string, dbName: string }} opts
 * @param {{ logger?: import('pino').Logger, slowQueryMs?: number }} [observability]
 *        when a logger is supplied, driver command monitoring is
 *        enabled and any command slower than ``slowQueryMs`` (default
 *        100) is logged with its name, target collection, and
 *        duration — the only way to answer "which query is slow" from
 *        Render logs without an APM.
 * @returns {Promise<DbContext>}
 *
 * Example:
 *   const ctx = await connect({ uri: cfg.mongoUri, dbName: cfg.mongoDb });
 */
async function connect({ uri, dbName }, observability = {}) {
  const logger = observability.logger || null;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: TIMEOUTS.MONGO_CONNECT_MS,
    socketTimeoutMS: TIMEOUTS.MONGO_SOCKET_MS,
    retryWrites: true,
    monitorCommands: !!logger,
  });
  if (logger) {
    attachSlowQueryLogging(client, logger, observability.slowQueryMs);
  }
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
    multichatStudio: db.collection(COLLECTIONS.MULTICHAT_STUDIO),
    mlModels: db.collection(COLLECTIONS.ML_MODELS),
    mlJobs: db.collection(COLLECTIONS.ML_JOBS),
    importJobs: db.collection(COLLECTIONS.IMPORT_JOBS),
    macroJobs: db.collection(COLLECTIONS.MACRO_JOBS),
    agentReleases: db.collection(COLLECTIONS.AGENT_RELEASES),
    communityBuilds: db.collection(COLLECTIONS.COMMUNITY_BUILDS),
    communityReports: db.collection(COLLECTIONS.COMMUNITY_REPORTS),
    userBackups: db.collection(COLLECTIONS.USER_BACKUPS),
    arcadeLeaderboard: db.collection(COLLECTIONS.ARCADE_LEADERBOARD),
    adminEvents: db.collection(COLLECTIONS.ADMIN_EVENTS),
    pulseAccounts: db.collection(COLLECTIONS.PULSE_ACCOUNTS),
    close: () => client.close(),
  };
  await ensureIndexes(ctx);
  return ctx;
}

// Commands that fire constantly as connection-pool chatter; logging
// them as "slow" would bury the queries that matter.
const SLOW_QUERY_IGNORED_COMMANDS = new Set([
  "ping",
  "hello",
  "ismaster",
  "isMaster",
  "endSessions",
  "saslStart",
  "saslContinue",
  "buildInfo",
  "getParameter",
]);

/**
 * Wire the driver's command-monitoring events into a slow-query log.
 * ``commandStarted`` carries the command document (whose first key's
 * value is the target collection); succeeded/failed only carry the
 * requestId + duration, so we keep a bounded requestId → target map
 * between the two events.
 *
 * @param {MongoClient} client
 * @param {import('pino').Logger} logger
 * @param {number} [thresholdMs]
 */
function attachSlowQueryLogging(client, logger, thresholdMs) {
  const slowMs =
    Number.isFinite(thresholdMs) && Number(thresholdMs) > 0
      ? Number(thresholdMs)
      : 100;
  /** @type {Map<number, string>} */
  const targets = new Map();
  client.on("commandStarted", (ev) => {
    if (SLOW_QUERY_IGNORED_COMMANDS.has(ev.commandName)) return;
    // First value of the command doc names the collection for CRUD /
    // aggregate commands ({find: "games", ...}); admin commands carry
    // a number — keep only strings.
    const target = ev.command ? ev.command[ev.commandName] : undefined;
    targets.set(
      ev.requestId,
      typeof target === "string" ? target : "",
    );
    // Bound the map so a burst of long-running commands can't grow it
    // unchecked if a terminal event is ever missed.
    if (targets.size > 1000) {
      // size > 1000 guarantees the iterator yields a key; TS can't
      // narrow ``.next().value`` through the size check.
      const first = /** @type {number} */ (targets.keys().next().value);
      targets.delete(first);
    }
  });
  client.on("commandSucceeded", (ev) => {
    const collection = targets.get(ev.requestId);
    targets.delete(ev.requestId);
    if (SLOW_QUERY_IGNORED_COMMANDS.has(ev.commandName)) return;
    if (ev.duration < slowMs) return;
    logger.warn(
      {
        commandName: ev.commandName,
        collection: collection || undefined,
        durationMs: Math.round(ev.duration),
      },
      "slow_query",
    );
  });
  client.on("commandFailed", (ev) => {
    const collection = targets.get(ev.requestId);
    targets.delete(ev.requestId);
    if (SLOW_QUERY_IGNORED_COMMANDS.has(ev.commandName)) return;
    logger.warn(
      {
        commandName: ev.commandName,
        collection: collection || undefined,
        durationMs: Math.round(ev.duration),
        err: ev.failure ? String(ev.failure.message || ev.failure) : undefined,
      },
      "mongo_command_failed",
    );
  });
}

/**
 * Idempotent index setup. Safe to call on every boot — Mongo skips
 * indexes that already exist with the same spec.
 *
 * Hot queries we index for:
 *   - opponents browse:   {userId, pulseId}
 *   - games by date:      {userId, date}
 *   - recent MMR enrich:  {createdAt, _id}
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
  // Admin per-user top-opponents card runs
  // ``find({userId}).sort({gameCount: -1}).limit(5)`` against this
  // collection (services/admin.js). Without this index the sort
  // scans every opponents row for the user — Atlas Performance
  // Advisor flagged ~16k docs scanned per 5-doc result.
  await ctx.opponents.createIndex({ userId: 1, gameCount: -1 });

  await ctx.games.createIndex({ userId: 1, gameId: 1 }, { unique: true });
  await ctx.games.createIndex({ userId: 1, date: -1 });
  // Global recent-row scan for opponentMmrEnrichmentJob. The job is
  // intentionally bounded by createdAt and walks oldest-first inside
  // that small window; without a global ingest-time index every
  // 15-minute tick would scan the full multi-user games corpus.
  await ctx.games.createIndex({ createdAt: 1, _id: 1 });
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
  // Display-name fallback: services/overlayLiveAggregations.js drops
  // to ``opponent.displayName`` when neither pulseId nor
  // pulseCharacterId is available on the envelope (legacy pre-Pulse
  // agents, unresolved-identity case). The two indexes below mirror
  // the pulseId pair above for that branch and follow Atlas
  // Performance Advisor field ordering.
  await ctx.games.createIndex({
    "opponent.displayName": 1,
    "opponent.race": 1,
    userId: 1,
    date: -1,
  });
  await ctx.games.createIndex({
    myRace: 1,
    "opponent.displayName": 1,
    "opponent.race": 1,
    userId: 1,
    date: -1,
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

  // Admin notification feed. Reverse-chronological reads are the hot
  // path; the unique partial index on user_signup events ensures a
  // Clerk webhook retry or a webhook-then-ensureFromClerk race can
  // never produce two signup rows for the same Clerk user id.
  await ctx.adminEvents.createIndex({ createdAt: -1 });
  await ctx.adminEvents.createIndex({ type: 1, createdAt: -1 });
  await ctx.adminEvents.createIndex(
    { "payload.clerkUserId": 1 },
    {
      unique: true,
      partialFilterExpression: { type: "user_signup" },
      name: "user_signup_unique_clerk",
    },
  );
  await ctx.adminEvents.createIndex({ readAt: 1, createdAt: -1 });

  // Global, cross-user SC2Pulse cache (services/pulseDirectory.js).
  // ``toonHandle`` is the natural key — one row per real SC2 account,
  // shared by every platform user. The unique index makes the
  // write-through upsert atomic; ``pulseCharacterId`` is sparse
  // because a row exists from the first MMR fetch even before a
  // character id is resolved. ``updatedAt`` powers the admin Global
  // tab's "recently refreshed" ordering.
  await ctx.pulseAccounts.createIndex({ toonHandle: 1 }, { unique: true });
  await ctx.pulseAccounts.createIndex(
    { pulseCharacterId: 1 },
    { sparse: true },
  );
  await ctx.pulseAccounts.createIndex({ updatedAt: -1 });
}

module.exports = { connect, ensureIndexes, attachSlowQueryLogging };
