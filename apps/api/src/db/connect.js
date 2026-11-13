"use strict";

const { MongoClient } = require("mongodb");
const { COLLECTIONS, TIMEOUTS } = require("../config/constants");
const { ensureGuideIndexes, startBackgroundIndexBuilds } = require("./guideIndexes");
const { PRIVATE_SEARCH_COMMENT } = require("../services/privateSearchReader");
const { COMMUNITY_SEARCH_COMMENT, REPLAY_SEARCH_COMMENT } = require("../middleware/searchQueryPrivacy");
const { REPLAY_DOWNLOAD_COMMENT } = require("../middleware/replayDownloadBatchBoundary");
const { startPrivateSearchIndex } = require("./privateSearchIndexes");
const { ensureNotesIndexes } = require("../services/notes");
const { PROTOCOL_VERSION, MAINTENANCE_VERSION } = require("../services/gameStatsMaintenance");
const { credentialReadinessCapability } = require("../services/deviceCredentialTopology");

/**
 * @typedef {{
 *   client: MongoClient,
 *   gameStatsTransactions: boolean,
 *   deviceCredentialReadiness: 'causal'|'writer-only-standalone'|'unavailable',
 *   db: import('mongodb').Db,
 *   backgroundIndexes?: import('./guideIndexes').BackgroundIndexBuilds,
 *   privateSearchIndexes?: import('./guideIndexes').BackgroundIndexBuilds, corpusIndexes?: import('./guideIndexes').BackgroundIndexBuilds,
 *   users: import('mongodb').Collection,
 *   profiles: import('mongodb').Collection,
 *   opponents: import('mongodb').Collection,
 *   opponentNotes: import('mongodb').Collection,
 *   notes: import('mongodb').Collection,
 *   games: import('mongodb').Collection,
 *   gameDetails: import('mongodb').Collection,
 *   customBuilds: import('mongodb').Collection,
 *   customBuildJobs: import('mongodb').Collection,
 *   customBuildRevisions: import('mongodb').Collection,
 *   communitySaves: import('mongodb').Collection,
 *   coaching: import('mongodb').Collection,
 *   devicePairings: import('mongodb').Collection,
 *   deviceTokens: import('mongodb').Collection,
 *   overlayTokens: import('mongodb').Collection,
 *   multichatStudio: import('mongodb').Collection,
 *   multichatSounds: import('mongodb').Collection,
 *   multichatEngagementEvents: import('mongodb').Collection,
 *   multichatViewers: import('mongodb').Collection,
 *   multichatPredictions: import('mongodb').Collection,
 *   multichatClipMoments: import('mongodb').Collection,
 *   platformConnections: import('mongodb').Collection,
 *   publicYoutubeArchives: import('mongodb').Collection,
 *   platformOauthStates: import('mongodb').Collection,
 *   youtubeCreateOperations: import('mongodb').Collection,
 *   platformWebhookReceipts: import('mongodb').Collection,
 *   platformEvents: import('mongodb').Collection,
 *   twitchRewardReceipts: import('mongodb').Collection<any>,
 *   twitchAutomationReceipts: import('mongodb').Collection<any>,
 *   importJobs: import('mongodb').Collection,
 *   macroJobs: import('mongodb').Collection,
 *   reanalysisJobs: import('mongodb').Collection,
 *   agentReleases: import('mongodb').Collection,
 *   communityBuilds: import('mongodb').Collection,
 *   communityReports: import('mongodb').Collection,
 *   userBackups: import('mongodb').Collection,
 *   pendingIdentityDeletions: import('mongodb').Collection<any>,
 *   arcadeLeaderboard: import('mongodb').Collection,
 *   adminEvents: import('mongodb').Collection,
 *   jobRuns: import('mongodb').Collection<any>,
 *   classifierQuality: import('mongodb').Collection<any>,
 *   classifierQualityIndexes?: import('./guideIndexes').BackgroundIndexBuilds,
 *   adminAudit: import('mongodb').Collection<any>,
 *   supportEmailSync: import('mongodb').Collection<any>,
 *   sitePresence: import('mongodb').Collection<import('../services/siteStats').SitePresenceDoc>,
 *   matchRooms: import('mongodb').Collection<import('../services/matchRooms').MatchRoomDoc>,
 *   dailyTally: import('mongodb').Collection<import('../services/dailyCrowd').TallyRow>,
 *   siteConfig: import('mongodb').Collection<any>,
 *   ghostExamples: import('mongodb').Collection<any>,
 *   pulseAccounts: import('mongodb').Collection,
 *   pulseCharacterLinks: import('mongodb').Collection,
 *   pulseBalanceCurrent: import('mongodb').Collection<import('../services/pulseBalanceStore').CurrentSnapshot>,
 *   pulseBalanceDaily: import('mongodb').Collection<import('../services/pulseBalanceStore').DailySnapshot>,
 *   playerChannels: import('mongodb').Collection,
 *   supporters: import('mongodb').Collection,
 *   donationMonths: import('mongodb').Collection<any>,
 *   playerIdentities: import('mongodb').Collection,
 *   playerIdentitySubmissions: import('mongodb').Collection,
 *   playerIdentityDirectory: import('mongodb').Collection,
 *   reviewRequests: import('mongodb').Collection<any>,
 *   reviewComments: import('mongodb').Collection<any>,
 *   reviewKarmaEvents: import('mongodb').Collection<any>,
 *   reviewBlocks: import('mongodb').Collection<any>,
 *   notifications: import('mongodb').Collection<any>,
 *   browserIngestDaily: import('mongodb').Collection<any>,
 *   guideSamples: import('mongodb').Collection,
 *   guideStats: import('mongodb').Collection,
 *   guideNotes: import('mongodb').Collection,
 *   guideVideos: import('mongodb').Collection<any>,
 *   buildIntentLive: import('mongodb').Collection<any>,
 *   playerGoals: import('mongodb').Collection<any>,
 *   streamSessions: import('mongodb').Collection<any>,
 *   discordHooks: import('mongodb').Collection<any>,
 *   discordOutbox: import('mongodb').Collection<any>,
 *   pushSubscriptions: import('mongodb').Collection<any>,
 *   gameShares: import('mongodb').Collection<any>,
 *   close: () => Promise<void>,
 * }} DbContext
 */

/** @param {import('mongodb').Db} db */
function adminCollections(db) {
  return {
    adminEvents: db.collection(COLLECTIONS.ADMIN_EVENTS),
    jobRuns: db.collection(COLLECTIONS.JOB_RUNS),
    classifierQuality: db.collection(COLLECTIONS.CLASSIFIER_QUALITY),
    adminAudit: db.collection(COLLECTIONS.ADMIN_AUDIT),
    supportEmailSync: db.collection(COLLECTIONS.SUPPORT_EMAIL_SYNC),
  };
}

/** @param {import('mongodb').Db} db @returns {Pick<DbContext, "sitePresence"|"matchRooms"|"dailyTally">} */
function publicLiveCollections(db) {
  return {
    sitePresence: db.collection(COLLECTIONS.SITE_PRESENCE),
    matchRooms: db.collection(COLLECTIONS.MATCH_ROOMS),
    dailyTally: db.collection(COLLECTIONS.DAILY_TALLY),
  };
}

/**
 * Open the MongoDB connection and return collection handles.
 *
 * @param {{ uri: string, dbName: string, awaitBackgroundIndexes?: boolean }} opts
 *        ``awaitBackgroundIndexes`` (tests): also wait for the
 *        background index builds before resolving; the boot path leaves
 *        it off so a slow build never delays ``listen``.
 * @param {{ logger?: import('pino').Logger, slowQueryMs?: number }} [observability]
 *        when a logger is supplied, driver command monitoring is
 *        enabled and any command slower than ``slowQueryMs`` (default
 *        100) is logged with its name, target collection, and
 *        duration — the only way to answer "which query is slow" from
 *        Render logs without an APM. The same logger reports the
 *        background index builds.
 * @returns {Promise<DbContext>}
 *
 * Example:
 *   const ctx = await connect({ uri: cfg.mongoUri, dbName: cfg.mongoDb });
 */
async function connect({ uri, dbName, awaitBackgroundIndexes = false }, observability = {}) {
  const logger = observability.logger || null;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: TIMEOUTS.MONGO_CONNECT_MS,
    socketTimeoutMS: TIMEOUTS.MONGO_SOCKET_MS,
    retryWrites: true,
    monitorCommands: !!logger,
  });
  if (logger) attachSlowQueryLogging(client, logger, observability.slowQueryMs);
  await client.connect();
  const db = client.db(dbName);
  // Check the connected topology rather than inferring transaction support
  // from a URI or a paid tier. No provider setting or topology is changed.
  let hello;
  try { hello = await db.admin().command({ hello: 1, maxTimeMS: 2000 }); }
  catch (error) { await client.close(); throw error; }
  const transactionTopology = Boolean((hello.setName && hello.maxWireVersion >= 7)
    || (hello.msg === "isdbgrid" && hello.maxWireVersion >= 8));
  const gameStatsTransactions = transactionTopology && typeof hello.logicalSessionTimeoutMinutes === "number";
  logger?.info({ gameStatsTransactions, protocolVersion: PROTOCOL_VERSION, maintenanceVersion: MAINTENANCE_VERSION }, "game_stats_transaction_capability");
  try { await db.createCollection(COLLECTIONS.JOB_RUNS, { capped: true, size: 8 * 1024 * 1024, max: 5000 }); }
  catch (error) { if (/** @type {any} */ (error).code !== 48) throw error; }
  const ctx = {
    client,
    gameStatsTransactions,
    deviceCredentialReadiness: credentialReadinessCapability(hello),
    db,
    users: db.collection(COLLECTIONS.USERS),
    profiles: db.collection(COLLECTIONS.PROFILES),
    opponents: db.collection(COLLECTIONS.OPPONENTS),
    opponentNotes: db.collection(COLLECTIONS.OPPONENT_NOTES), notes: db.collection(COLLECTIONS.NOTES),
    games: db.collection(COLLECTIONS.GAMES),
    gameDetails: db.collection(COLLECTIONS.GAME_DETAILS),
    customBuilds: db.collection(COLLECTIONS.CUSTOM_BUILDS),
    customBuildJobs: db.collection(COLLECTIONS.CUSTOM_BUILD_JOBS),
    customBuildRevisions: db.collection(COLLECTIONS.CUSTOM_BUILD_REVISIONS),
    devicePairings: db.collection(COLLECTIONS.DEVICE_PAIRINGS),
    deviceTokens: db.collection(COLLECTIONS.DEVICE_TOKENS),
    overlayTokens: db.collection(COLLECTIONS.OVERLAY_TOKENS),
    multichatStudio: db.collection(COLLECTIONS.MULTICHAT_STUDIO),
    multichatSounds: db.collection(COLLECTIONS.MULTICHAT_SOUNDS),
    multichatEngagementEvents: db.collection(COLLECTIONS.MULTICHAT_ENGAGEMENT_EVENTS),
    multichatViewers: db.collection(COLLECTIONS.MULTICHAT_VIEWERS),
    multichatPredictions: db.collection(COLLECTIONS.MULTICHAT_PREDICTIONS),
    multichatClipMoments: db.collection(COLLECTIONS.MULTICHAT_CLIP_MOMENTS),
    platformConnections: db.collection(COLLECTIONS.PLATFORM_CONNECTIONS),
    publicYoutubeArchives: db.collection(COLLECTIONS.PUBLIC_YOUTUBE_ARCHIVES),
    platformOauthStates: db.collection(COLLECTIONS.PLATFORM_OAUTH_STATES),
    youtubeCreateOperations: db.collection(COLLECTIONS.YOUTUBE_CREATE_OPERATIONS),
    platformWebhookReceipts: db.collection(COLLECTIONS.PLATFORM_WEBHOOK_RECEIPTS),
    platformEvents: db.collection(COLLECTIONS.PLATFORM_EVENTS),
    twitchRewardReceipts: db.collection(COLLECTIONS.TWITCH_REWARD_RECEIPTS),
    twitchAutomationReceipts: db.collection(COLLECTIONS.TWITCH_AUTOMATION_RECEIPTS),
    importJobs: db.collection(COLLECTIONS.IMPORT_JOBS),
    macroJobs: db.collection(COLLECTIONS.MACRO_JOBS),
    reanalysisJobs: db.collection(COLLECTIONS.REANALYSIS_JOBS),
    agentReleases: db.collection(COLLECTIONS.AGENT_RELEASES),
    communityBuilds: db.collection(COLLECTIONS.COMMUNITY_BUILDS),
    communityReports: db.collection(COLLECTIONS.COMMUNITY_REPORTS),
    communitySaves: db.collection(COLLECTIONS.COMMUNITY_SAVES),
    userBackups: db.collection(COLLECTIONS.USER_BACKUPS),
    pendingIdentityDeletions: db.collection(COLLECTIONS.PENDING_IDENTITY_DELETIONS),
    arcadeLeaderboard: db.collection(COLLECTIONS.ARCADE_LEADERBOARD),
    ...adminCollections(db),
    siteConfig: db.collection(COLLECTIONS.SITE_CONFIG),
    ghostExamples: db.collection(COLLECTIONS.GHOST_EXAMPLES),
    ...publicLiveCollections(db),
    coaching: db.collection(COLLECTIONS.COACHING),
    pulseAccounts: db.collection(COLLECTIONS.PULSE_ACCOUNTS),
    pulseCharacterLinks: db.collection(COLLECTIONS.PULSE_CHARACTER_LINKS),
    pulseBalanceCurrent: /** @type {DbContext['pulseBalanceCurrent']} */ (db.collection(COLLECTIONS.PULSE_BALANCE_CURRENT)),
    pulseBalanceDaily: /** @type {DbContext['pulseBalanceDaily']} */ (db.collection(COLLECTIONS.PULSE_BALANCE_DAILY)),
    playerChannels: db.collection(COLLECTIONS.PLAYER_CHANNELS),
    ...donationCollections(db),
    playerIdentities: db.collection(COLLECTIONS.PLAYER_IDENTITIES),
    playerIdentitySubmissions: db.collection(COLLECTIONS.PLAYER_IDENTITY_SUBMISSIONS),
    playerIdentityDirectory: db.collection(COLLECTIONS.PLAYER_IDENTITY_DIRECTORY),
    reviewRequests: db.collection(COLLECTIONS.REVIEW_REQUESTS),
    reviewComments: db.collection(COLLECTIONS.REVIEW_COMMENTS),
    reviewKarmaEvents: db.collection(COLLECTIONS.REVIEW_KARMA_EVENTS),
    reviewBlocks: db.collection(COLLECTIONS.REVIEW_BLOCKS),
    notifications: db.collection(COLLECTIONS.NOTIFICATIONS),
    browserIngestDaily: db.collection(COLLECTIONS.BROWSER_INGEST_DAILY),
    guideSamples: db.collection(COLLECTIONS.GUIDE_SAMPLES),
    guideStats: db.collection(COLLECTIONS.GUIDE_STATS),
    guideNotes: db.collection(COLLECTIONS.GUIDE_NOTES),
    guideVideos: db.collection(COLLECTIONS.GUIDE_VIDEOS),
    buildIntentLive: db.collection(COLLECTIONS.BUILD_INTENT_LIVE), gameShares: db.collection(COLLECTIONS.GAME_SHARES), ...deliveryCollections(db),
    playerGoals: db.collection(COLLECTIONS.PLAYER_GOALS),
    close: () => client.close(),
  };
  await ensureIndexes(ctx, { logger, awaitBackground: awaitBackgroundIndexes });
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

// Reads whose filter or pipeline holds typed search text: their failures log a code only.
const PRIVATE_COMMENTS = new Set([PRIVATE_SEARCH_COMMENT, REPLAY_SEARCH_COMMENT, COMMUNITY_SEARCH_COMMENT, REPLAY_DOWNLOAD_COMMENT]);

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
  /** @type {Map<number, {collection:string,private:boolean}>} */
  const targets = new Map();
  client.on("commandStarted", (ev) => {
    if (SLOW_QUERY_IGNORED_COMMANDS.has(ev.commandName)) return;
    // First value of the command doc names the collection for CRUD /
    // aggregate commands ({find: "games", ...}); admin commands carry
    // a number — keep only strings.
    const target = ev.command ? ev.command[ev.commandName] : undefined;
    targets.set(
      ev.requestId,
      { collection: typeof target === "string" ? target : "",
        private: target === COLLECTIONS.DAILY_TALLY || PRIVATE_COMMENTS.has(ev.command?.comment) },
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
    const metadata = targets.get(ev.requestId);
    targets.delete(ev.requestId);
    if (SLOW_QUERY_IGNORED_COMMANDS.has(ev.commandName)) return;
    if (ev.duration < slowMs) return;
    logger.warn(
      {
        commandName: ev.commandName,
        collection: metadata?.collection || undefined,
        durationMs: Math.round(ev.duration),
      },
      "slow_query",
    );
  });
  client.on("commandFailed", (ev) => {
    const metadata = targets.get(ev.requestId);
    targets.delete(ev.requestId);
    if (SLOW_QUERY_IGNORED_COMMANDS.has(ev.commandName)) return;
    logger.warn(
      {
        commandName: ev.commandName,
        collection: metadata?.collection || undefined,
        durationMs: Math.round(ev.duration),
        // Unknown/evicted metadata is private until proven otherwise. Never
        // forward a database error that may echo a private search pipeline.
        ...(metadata && !metadata.private
          ? { err: ev.failure ? String(ev.failure.message || ev.failure) : undefined }
          : { code: "mongo_command_failed" }),
      },
      "mongo_command_failed",
    );
  });
}

/**
 * Per-user, per-UTC-day browser-ingest counters. One row per (userId, day);
 * the TTL index reclaims rows once their ``expiresAt`` (a few days after the
 * counted day) passes. See ``services/browserIngestQuota.js``.
 *
 * Example:
 *   await ensureBrowserIngestDailyIndexes(ctx);
 *
 * @param {{ browserIngestDaily: import('mongodb').Collection }} ctx
 */
async function ensureBrowserIngestDailyIndexes(ctx) {
  await ctx.browserIngestDaily.createIndex({ userId: 1, day: 1 }, { unique: true });
  await ctx.browserIngestDaily.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

/** @param {DbContext} ctx */
async function ensurePublicLiveIndexes(ctx) {
  // Presence queries enforce expiry independently of MongoDB's TTL sweep.
  await ctx.sitePresence.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await ctx.sitePresence.createIndex({ lastSeenAt: -1, identityKey: 1 });
  await ctx.matchRooms.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await ctx.matchRooms.createIndex({ slot: 1 }, { unique: true, sparse: true });
  await ctx.matchRooms.createIndex({ creationDigest: 1 }, { unique: true });
  await ctx.dailyTally.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await ctx.dailyTally.createIndex({ day: 1, pack: 1 });
}

/**
 * Private practice log (services/practiceLog.js): one owner's graded games in
 * a matchup, newest first. Partial, so only games with a ``practice`` record
 * are indexed; every practice read includes ``practice: {$exists: true}``.
 *
 * @param {{ games: import('mongodb').Collection }} ctx
 */
async function ensurePracticeLogIndexes(ctx) {
  await ctx.games.createIndex(
    { userId: 1, "practice.matchup": 1, date: -1, _id: -1 },
    { name: "practice_log", partialFilterExpression: { practice: { $exists: true } } },
  );
}

/**
 * Build library safety and community trust: tag chips (multikey), the
 * trash purge's soft-deleted rows, version history, "Most saved" and one
 * community save per account.
 * @param {DbContext} ctx
 */
async function ensureBuildLibraryIndexes(ctx) {
  await ctx.customBuilds.createIndex({ userId: 1, tags: 1 });
  await ctx.customBuilds.createIndex(
    { deletedAt: 1 },
    { name: "custom_build_trash", partialFilterExpression: { deletedAt: { $exists: true } } },
  );
  await ctx.customBuildRevisions.createIndex({ userId: 1, slug: 1, rev: -1 }, { unique: true });
  await ctx.communityBuilds.createIndex({ removed: 1, saves: -1 });
  await ctx.communitySaves.createIndex({ slug: 1, userId: 1 }, { unique: true });
  await ctx.communitySaves.createIndex({ userId: 1 });
}

/**
 * Build check-in (services/buildIntents.js). Live records are unique per
 * (userId, gameKey); the ingest bind looks up a user's unbound records by
 * key start time; the TTL index reclaims them at ``expiresAt``. The partial
 * games index serves the pending queue without allocating entries for the
 * (much larger) set of games that never had a pending check-in.
 *
 * @param {{ buildIntentLive: import('mongodb').Collection<any>, games: import('mongodb').Collection }} ctx
 */
async function ensureBuildIntentIndexes(ctx) {
  await ctx.buildIntentLive.createIndex({ userId: 1, gameKey: 1 }, { unique: true });
  await ctx.buildIntentLive.createIndex({ userId: 1, gameId: 1, keyStartedAtMs: 1 });
  await ctx.buildIntentLive.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await ctx.games.createIndex(
    { userId: 1, "buildIntent.status": 1, date: -1 },
    {
      name: "build_intent_pending",
      partialFilterExpression: { "buildIntent.status": "pending" },
    },
  );
}

/** @param {DbContext} ctx */
async function ensureAdminEventIndexes(ctx) {
  await ctx.adminEvents.createIndex({ readAt: 1, createdAt: -1, eventId: -1 });
  await ctx.adminEvents.createIndex({ type: 1, readAt: 1, createdAt: -1, eventId: -1 });
  await ctx.adminEvents.createIndex({ type: 1, readAt: 1, "report.status": 1 }, { partialFilterExpression: { type: "user_message" } });
  // Per-event read/unread (POST /v1/admin/events/:eventId/read|unread)
  // looks a row up by id alone; the keyset indexes above lead with
  // createdAt/type. Not unique: a legacy duplicate must never fail boot.
  await ctx.adminEvents.createIndex({ eventId: 1 }, { name: "admin_events_event_id" });
  await ctx.adminEvents.createIndex(
    { ingestionKey: 1 },
    {
      unique: true,
      partialFilterExpression: { ingestionKey: { $type: "string" } },
      name: "admin_event_unique_ingestion",
    },
  );
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
 *   - browser ingest cap: {userId, day} (unique, TTL on expiresAt)
 *
 * Every index is awaited except BACKGROUND_GAMES_INDEXES
 * (db/guideIndexes.js), which are only started here so a long first build
 * never holds boot; their progress lands on ``ctx.backgroundIndexes``
 * (also the return value).
 *
 * @param {DbContext} ctx
 * @param {{ logger?: import('pino').Logger|null, awaitBackground?: boolean }} [opts]
 *        ``awaitBackground`` waits for the background builds too (tests)
 * @returns {Promise<import('./guideIndexes').BackgroundIndexBuilds>}
 */
async function ensureIndexes(ctx, opts = {}) {
  await ctx.ghostExamples.createIndex({ ownerUserId: 1, sourceGameId: 1, side: 1 }, { unique: true });
  await ctx.ghostExamples.createIndex({ publishedAt: -1, _id: 1 });
  await ctx.ghostExamples.createIndex({ matchup: 1, publishedAt: -1, _id: 1 });
  await Promise.all([
    ctx.siteConfig.createIndex({ kind: 1, revision: -1 }, { name: "preset_policy_history" }),
    ctx.jobRuns.createIndex({ job: 1, startedAt: -1 }),
    ctx.classifierQuality.createIndex({ kind: 1, generatedAt: -1 }),
    ctx.users.createIndex({ createdAt: -1, userId: 1 }),
    ctx.adminAudit.createIndex({ createdAt: 1 }, { expireAfterSeconds: 400 * 86400 }),
    ctx.adminAudit.createIndex({ target: 1, createdAt: -1 }),
    ctx.adminAudit.createIndex({ action: 1, createdAt: -1 }),
    ctx.adminAudit.createIndex({ createdAt: -1, auditId: -1 }),
  ]);
  await ctx.playerIdentities.createIndex({ sourceKeys: 1 }, { unique: true, sparse: true });
  await ctx.playerIdentities.createIndex({ targetKeys: 1, active: 1 });
  await ctx.playerIdentities.createIndex({ kind: 1 }, { unique: true, partialFilterExpression: { kind: "graph-revision" } });
  await ctx.playerIdentitySubmissions.createIndex({ id: 1 }, { unique: true });
  await ctx.playerIdentitySubmissions.createIndex({ userId: 1, sourceKey: 1 }, { unique: true, partialFilterExpression: { direct: false } });
  await ctx.playerIdentitySubmissions.createIndex({ status: 1, createdAt: 1, id: 1 });
  await ctx.games.createIndex({ userId: 1, "opponent.pulseId": 1, _id: -1 });
  await ctx.games.createIndex({ userId: 1, "opponent.pulseCharacterId": 1, _id: -1 });
  await ctx.playerIdentityDirectory.createIndex({ key: 1 }, { unique: true });
  await ctx.playerIdentityDirectory.createIndex({ searchNames: 1, key: 1 });
  await ctx.playerIdentityDirectory.createIndex({ identityKeys: 1 });
  await ctx.opponents.createIndex({ lastSeen: 1 });
  await ctx.pulseAccounts.createIndex({ updatedAt: 1 });
  await ensureDirectoryIndexes(ctx);
  await ctx.publicYoutubeArchives.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await ctx.users.createIndex({ clerkUserId: 1 }, { unique: true });
  // Internal UUIDs remain unique account keys, but public replay links use a
  // separate readable slug so URLs do not disclose those keys. The partial
  // index ignores missing/null legacy values until they are lazily assigned a
  // canonical string slug. ``shareId`` remains indexed only as a compatibility
  // alias for active links created before player slugs shipped.
  await ctx.users.createIndex({ userId: 1 }, { unique: true, sparse: true });
  await ctx.users.createIndex(
    { "replaySharing.slug": 1 },
    {
      unique: true,
      partialFilterExpression: { "replaySharing.slug": { $type: "string" } },
    },
  );
  await ctx.users.createIndex(
    { "replaySharing.shareId": 1 },
    { unique: true, sparse: true },
  );

  await ctx.opponents.createIndex({ userId: 1, pulseId: 1 }, { unique: true });
  // Public-profile availability resolves a toon across users. A userId-leading
  // index cannot answer this lookup; include the character id for a covered read.
  await ctx.opponents.createIndex({ pulseId: 1, pulseCharacterId: 1 });
  await ctx.opponents.createIndexes([{ key: { userId: 1, pulseCharacterId: 1 } }, { key: { userId: 1, lastSeen: -1 } }]);
  // Admin per-user top-opponents card runs
  // ``find({userId}).sort({gameCount: -1}).limit(5)`` against this
  // collection (services/admin.js). Without this index the sort
  // scans every opponents row for the user — Atlas Performance
  // Advisor flagged ~16k docs scanned per 5-doc result.
  await ctx.opponents.createIndex({ userId: 1, gameCount: -1 });
  await ctx.opponentNotes.createIndex({ userId: 1, pulseId: 1 }, { unique: true });
  await ensureNotesIndexes(ctx.notes); // target, group-key and one-note-per-account slots

  await ctx.games.createIndex({ userId: 1, gameId: 1 }, { unique: true });
  await ctx.games.createIndex({ userId: 1, date: -1 });
  await ctx.games.createIndex({ userId: 1, date: -1, "buildIntent.randomizer.key": 1 }, {
    name: "randomizer_challenge_owner_date",
    partialFilterExpression: { "buildIntent.randomizer.key": { $type: "string" } },
  });
  // Complete-history analysis is cursor-paged by (date, _id).  The _id
  // tie-breaker prevents replay rows with identical timestamps from being
  // skipped between pages while this compound order avoids a blocking sort.
  await ctx.games.createIndex({ userId: 1, date: -1, _id: -1 });
  // Public infrastructure usage counts only completed original-replay
  // markers. A partial index keeps that global count index-only without
  // allocating entries for the much larger set of pre-archive game rows.
  await ctx.games.createIndex(
    { "replayFile.storedAt": 1 },
    {
      name: "replay_file_stored_at",
      partialFilterExpression: {
        "replayFile.storedAt": { $exists: true },
      },
    },
  );
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
  await ctx.customBuilds.createIndex({ userId: 1, _id: 1 }, { name: "admin_custom_build_catalog" });
  await ctx.customBuildJobs.createIndex({ userId: 1 }, { unique: true });
  await ensureBuildLibraryIndexes(ctx);
  await ctx.customBuildJobs.createIndex({ status: 1, leaseUntil: 1 });

  await ctx.devicePairings.createIndex({ code: 1 }, { unique: true });
  await ctx.devicePairings.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  // Engagement: raw event refs are dedupe keys with a 48 h TTL; the
  // aggregates (viewers/predictions/clip moments) are what persist.
  await ctx.multichatEngagementEvents.createIndex(
    { token: 1, platform: 1, msgId: 1 },
    { unique: true },
  );
  await ctx.multichatEngagementEvents.createIndex(
    { atDate: 1 },
    { expireAfterSeconds: 48 * 60 * 60 },
  );
  // New writes lazily mark one authoritative studio row per overlay token.
  // Sparse avoids a risky startup migration if an older unindexed deployment
  // ever produced duplicate legacy rows; the service promotes one row on its
  // next write and all later reads prefer that canonical key.
  await ctx.multichatStudio.createIndex(
    { studioKey: 1 },
    { unique: true, sparse: true },
  );
  await ctx.multichatViewers.createIndex(
    { token: 1, userKey: 1 },
    { unique: true },
  );
  await ctx.multichatViewers.createIndex({ token: 1, xp: -1 });
  await ctx.multichatPredictions.createIndex(
    { token: 1, gameKey: 1 },
    { unique: true },
  );
  await ctx.multichatPredictions.createIndex({ token: 1, openedAt: -1 });
  await ctx.multichatClipMoments.createIndex({ token: 1, atMs: -1, _id: -1 });
  await ctx.multichatClipMoments.createIndex(
    { atDate: 1 },
    { expireAfterSeconds: 7 * 24 * 60 * 60 },
  );

  await ctx.platformConnections.createIndex(
    { userId: 1, platform: 1 },
    { unique: true },
  );
  await ctx.platformConnections.createIndex(
    { platform: 1, platformUserId: 1 },
    { unique: true, sparse: true },
  );
  await ctx.platformOauthStates.createIndex({ stateHash: 1 }, { unique: true });
  await ctx.platformOauthStates.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );
  await ctx.platformWebhookReceipts.createIndex(
    { platform: 1, messageId: 1 },
    { unique: true },
  );
  await ctx.platformWebhookReceipts.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );
  await ctx.platformEvents.createIndex(
    { userId: 1, platform: 1, eventId: 1 },
    { unique: true },
  );
  await ctx.platformEvents.createIndex({ userId: 1, receivedAt: -1 });
  await ctx.platformEvents.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );
  await new (require("../services/twitchRewardReceipts").TwitchRewardReceipts)(ctx.twitchRewardReceipts).ensureIndexes();
  await new (require("../services/twitchAutomationReceipts").TwitchAutomationReceipts)({ collection: ctx.twitchAutomationReceipts }).ensureIndexes();

  await ctx.deviceTokens.createIndex({ tokenHash: 1 }, { unique: true });
  await ctx.deviceTokens.createIndex({ userId: 1, lastSeenAt: -1 });
  await ctx.deviceTokens.createIndex({ revokedAt: 1, lastSeenAt: -1 });

  await ensurePublicLiveIndexes(ctx);
  await ensureBrowserIngestDailyIndexes(ctx);

  await ctx.overlayTokens.createIndex({ token: 1 }, { unique: true });
  await ctx.overlayTokens.createIndex({ userId: 1, createdAt: -1 });

  // Analytics hot-paths added by the C-bucket port. These accelerate
  // the $facet aggregations the AggregationsService and BuildsService
  // run on every tab change in the SPA.
  await ctx.games.createIndex({ userId: 1, myBuild: 1, date: -1 });
  // Authoritative custom-build stats/dossiers group by the private provenance
  // slug rather than the mutable display name. This keeps those reads as one
  // narrow index range even while an agent is syncing replay details.
  await ctx.games.createIndex({ userId: 1, _customBuildSlug: 1, date: -1 });
  await ctx.games.createIndex({
    userId: 1,
    _customOpponentStrategySlug: 1,
    date: -1,
  });
  await ctx.games.createIndex({ userId: 1, "opponent.strategy": 1 });
  await ctx.games.createIndex({ userId: 1, map: 1, date: -1 });
  // The cross-user guides index {myBuild, opponent.race} is built in the
  // background after the awaited builds: BACKGROUND_GAMES_INDEXES in
  // db/guideIndexes.js explains why.

  // Coaching practice requirements live beside the Locker/calendar documents
  // but are independently revisioned. These indexes keep role-scoped lists
  // narrow and make a coach's clientRequestId an idempotency key.
  await ctx.coaching.createIndex(
    { kind: 1, coachId: 1, studentId: 1, createdAt: -1 },
    { name: "coaching_assignment_coach_student" },
  );
  await ctx.coaching.createIndex(
    { kind: 1, studentId: 1, createdAt: -1 },
    { name: "coaching_assignment_student" },
  );
  await ctx.coaching.createIndex(
    { kind: 1, coachId: 1, clientRequestId: 1 },
    {
      name: "coaching_assignment_request",
      unique: true,
      partialFilterExpression: {
        kind: "game_requirement",
        clientRequestId: { $type: "string" },
      },
    },
  );


  await ctx.importJobs.createIndex({ userId: 1, createdAt: -1 });
  await ctx.macroJobs.createIndex({ userId: 1, createdAt: -1 });
  // One active re-analysis per owner; finished runs expire after 90 days.
  await ctx.reanalysisJobs.createIndex({ userId: 1 }, { unique: true, partialFilterExpression: { active: true }, name: "reanalysis_one_active" });
  await ctx.reanalysisJobs.createIndex({ userId: 1, createdAt: -1 });
  await ctx.reanalysisJobs.createIndex({ completedAt: 1 }, { expireAfterSeconds: 90 * 86400 });

  await ctx.agentReleases.createIndex({ channel: 1, version: 1 }, { unique: true });
  await ctx.agentReleases.createIndex({ channel: 1, publishedAt: -1 });

  // Community indexes — slug is the public URL key. {removed: 1, votes: -1}
  // serves "top published" lists; {ownerUserId, slug} keeps per-author
  // dedupe + the publish/unpublish toggle.
  await ctx.communityBuilds.createIndex({ slug: 1 }, { unique: true });
  await ctx.communityBuilds.createIndex({ ownerUserId: 1, slug: 1 });
  await ctx.communityBuilds.createIndex({ ownerUserId: 1, _id: 1 }, { name: "admin_community_build_catalog" });
  await ctx.communityBuilds.createIndex({ removed: 1, votes: -1 });
  await ctx.communityBuilds.createIndex({ matchup: 1, removed: 1, votes: -1 });
  await ctx.communityBuilds.createIndex({ removed: 1, "build.race": 1, "build.vsRace": 1, votes: -1 });
  await ctx.communityBuilds.createIndex({ removed: 1, "build.skillLevel": 1, votes: -1 });
  await ctx.communityBuilds.createIndex({ removed: 1, updatedAt: -1 });

  await ctx.communityReports.createIndex({ targetType: 1, targetId: 1 });
  await ctx.communityReports.createIndex({ targetType: 1, targetId: 1, resolvedAt: -1 });
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
  // path; the unique partial index on active user_signup events ensures a
  // Clerk webhook retry or a webhook-then-ensureFromClerk race can never
  // produce two signup rows for the same Clerk user id. GDPR keeps an
  // anonymized event row for aggregate counts, so those rows (whose Clerk id
  // has been cleared) must not participate in uniqueness.
  await ctx.adminEvents.createIndex({ createdAt: -1, eventId: -1 });
  await ctx.adminEvents.createIndex({ type: 1, createdAt: -1, eventId: -1 });
  // Build the corrected index under a new name before removing the legacy
  // one. This avoids both an IndexOptionsConflict on deployed databases and
  // a window without duplicate protection while instances roll forward.
  await ctx.adminEvents.createIndex(
    { "payload.clerkUserId": 1 },
    {
      unique: true,
      partialFilterExpression: {
        type: "user_signup",
        // Partial indexes do not support `$exists: false`; equality with
        // null includes the missing field on active rows while excluding the
        // Date stamped by GDPR anonymization.
        anonymizedAt: null,
        "payload.clerkUserId": { $type: "string" },
      },
      name: "user_signup_unique_active_clerk",
    },
  );
  if (await ctx.adminEvents.indexExists("user_signup_unique_clerk")) {
    try {
      await ctx.adminEvents.dropIndex("user_signup_unique_clerk");
    } catch (err) {
      // Two application instances can observe the legacy index during a
      // rolling deploy and race to remove it. The second removal is already
      // at the desired state; every other failure remains fatal at startup.
      const code = /** @type {any} */ (err)?.code;
      const codeName = /** @type {any} */ (err)?.codeName;
      if (code !== 27 && codeName !== "IndexNotFound") throw err;
    }
  }
  await ensureAdminEventIndexes(ctx);

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

  // Global SC2Pulse character → account/pro linkage cache
  // (services/pulseCharacterLinks.js). One row per character id; the
  // unique index makes the batch write-through upsert atomic.
  await ctx.pulseCharacterLinks.createIndex(
    { pulseCharacterId: 1 },
    { unique: true },
  );
  await ctx.pulseCharacterLinks.createIndex({ updatedAt: -1 });
  await ctx.pulseCharacterLinks.createIndex({ accountId: 1 }, { sparse: true });
  await ctx.pulseCharacterLinks.createIndex({ toonHandle: 1 }, { sparse: true });

  await ensureBuildIntentIndexes(ctx);
  await ensurePracticeLogIndexes(ctx);
  await ensureGuideIndexes(ctx);
  await ensureReviewIndexes(ctx); await ensurePlayerGoalIndexes(ctx); await ensureDeliveryIndexes(ctx);
  // Last, so the ``games`` collection exists and the long build never
  // competes with the awaited ones above.
  const logger = opts.logger || null, guides = startBackgroundIndexBuilds(ctx, logger);
  const search = startPrivateSearchIndex(ctx, logger), corpus = require("./corpusIndexes").startCorpusStampIndex(ctx, logger);
  const classifier = require("./classifierQualityIndexes").startClassifierQualityIndexes(ctx, logger);
  // GuideStats waits on this existing guide-only authority. The unrelated optional
  // search and corpus-stamp builds must not lengthen its bounded readiness wait.
  ctx.backgroundIndexes = guides; ctx.corpusIndexes = corpus;
  ctx.privateSearchIndexes = search; ctx.classifierQualityIndexes = classifier;
  if (opts.awaitBackground) await Promise.all([guides.settled, search.settled, corpus.settled, classifier.settled]);
  return guides;
}

/**
 * Personal goals (services/playerGoals.js): lookups by public id, the
 * active/completed lists, and the active-goal cap. Only an active goal
 * holds a ``slot`` (0..7), so the unique partial index makes "at most 8
 * active goals" a constraint instead of a racy count.
 *
 * @param {{ playerGoals: import('mongodb').Collection<any> }} ctx
 */
async function ensurePlayerGoalIndexes(ctx) {
  await ctx.playerGoals.createIndex({ userId: 1, id: 1 }, { unique: true });
  await ctx.playerGoals.createIndex({ userId: 1, status: 1, completedAt: -1 });
  await ctx.playerGoals.createIndex(
    { userId: 1, slot: 1 },
    { unique: true, partialFilterExpression: { slot: { $exists: true } }, name: "player_goals_active_slot" },
  );
}

/**
 * Replay Review Exchange + user notifications (docs/reviews.md).
 *
 * Board reads filter on the denormalised ``listed`` flag (public
 * visibility, open/answered, not moderation-hidden) so every sort is a
 * single index range: New = createdAt, Hot = the monotone ``hotScore``
 * (activity with an age term baked in at write time, so it never needs
 * a decay sweep), Top = ``topScore``. ``activeKey`` is present only while
 * a request is open/answered, making "one live request per game" a
 * unique-sparse constraint instead of a racy read-then-insert.
 *
 * @param {DbContext} ctx
 */
async function ensureReviewIndexes(ctx) {
  await ctx.reviewRequests.createIndex({ activeKey: 1 }, { unique: true, sparse: true });
  await ctx.reviewRequests.createIndex({ userId: 1, createdAt: -1 });
  await ctx.reviewRequests.createIndex({ userId: 1, gameId: 1 });
  await ctx.reviewRequests.createIndex({ listed: 1, createdAt: -1, _id: -1 });
  await ctx.reviewRequests.createIndex({ listed: 1, hotScore: -1, _id: -1 });
  await ctx.reviewRequests.createIndex({ listed: 1, topScore: -1, _id: -1 });
  await ctx.reviewRequests.createIndex({ listed: 1, matchup: 1, createdAt: -1 });
  await ctx.reviewRequests.createIndex({ listed: 1, reviewCount: 1, createdAt: -1 });
  await ctx.reviewRequests.createIndex({ indexable: 1, lastActivityAt: -1 });

  await ctx.reviewComments.createIndex({ requestId: 1, createdAt: 1, _id: 1 });
  await ctx.reviewComments.createIndex({ authorId: 1, createdAt: -1 });
  await ctx.reviewComments.createIndex({ authorId: 1, upvotes: -1, createdAt: -1, _id: -1 });
  await ctx.reviewComments.createIndex({ parentId: 1 }, { sparse: true });

  // One reward per (comment, kind, actor). GDPR anonymisation clears a
  // deleted actor's id, so only string actors participate in uniqueness.
  await ctx.reviewKarmaEvents.createIndex(
    { commentId: 1, kind: 1, actorId: 1 },
    {
      unique: true,
      partialFilterExpression: { actorId: { $type: "string" } },
      name: "review_karma_idempotency",
    },
  );
  await ctx.reviewKarmaEvents.createIndex({ userId: 1, createdAt: -1 });
  await ctx.reviewKarmaEvents.createIndex({ createdAt: -1, userId: 1 });

  await ctx.reviewBlocks.createIndex({ blockerId: 1, blockedId: 1 }, { unique: true });
  await ctx.reviewBlocks.createIndex({ blockedId: 1 });

  // Game share links: ``activeKey`` exists only while a link is live, so
  // one game has at most one active link (services/gameShares.js).
  await ctx.gameShares.createIndex({ activeKey: 1 }, { unique: true, sparse: true });
  await ctx.gameShares.createIndex({ userId: 1, gameId: 1, createdAt: -1 });
  await ctx.gameShares.createIndex({ userId: 1, revokedAt: 1 });

  await ctx.notifications.createIndex({ userId: 1, createdAt: -1 });
  await ctx.notifications.createIndex({ userId: 1, readAt: 1 });
  await ctx.notifications.createIndex(
    { userId: 1, deliveryKeys: 1 },
    { unique: true, partialFilterExpression: { deliveryKeys: { $type: "array" } }, name: "notification_delivery_key" },
  );
  await ctx.adminEvents.createIndex({ "payload.userId": 1, type: 1, createdAt: -1 });
  // User-scoped activity has no type prefix; retain keyset timestamp ties.
  await ctx.adminEvents.createIndex({ "payload.userId": 1, createdAt: -1, eventId: -1 });
  // Grouped notifications ("3 new reviews on your request") collapse onto
  // the caller's single UNREAD row per group; once read, the next event
  // starts a fresh row.
  await ctx.notifications.createIndex(
    { userId: 1, groupKey: 1 },
    {
      unique: true,
      partialFilterExpression: { readAt: null, groupKey: { $type: "string" } },
      name: "notification_unread_group",
    },
  );
  // In-app notifications are a bell, not an archive.
  await ctx.notifications.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 90 * 24 * 60 * 60, name: "notification_ttl" },
  );
  await ctx.users.createIndex({ "reviewer.karma": -1 }, { sparse: true });
}

/**
 * Reports and delivery channels (docs/notifications.md).
 * @param {import('mongodb').Db} db
 */
function deliveryCollections(db) {
  return {
    streamSessions: db.collection(COLLECTIONS.STREAM_SESSIONS),
    discordHooks: db.collection(COLLECTIONS.DISCORD_HOOKS),
    discordOutbox: db.collection(COLLECTIONS.DISCORD_OUTBOX),
    pushSubscriptions: db.collection(COLLECTIONS.PUSH_SUBSCRIPTIONS),
  };
}

/**
 * Weekly/stream reports, Discord posts, Web Push and the calendar feed
 * (docs/notifications.md). Every lookup is owner-keyed except the two
 * bearer-secret lookups (calendar feed hash, push endpoint hash) and the
 * outbox drain, which reads due rows across users in send order.
 *
 * @param {DbContext} ctx
 */
async function ensureDeliveryIndexes(ctx) {
  await ctx.streamSessions.createIndex({ userId: 1, streamId: 1 }, { unique: true });
  await ctx.streamSessions.createIndex({ userId: 1, startAt: -1 });
  await ctx.streamSessions.createIndex({ userId: 1, publicId: 1 }, { unique: true, partialFilterExpression: { publicId: { $type: "string" } } });
  await ctx.streamSessions.createIndex({ reportState: 1, endAt: 1 }, { partialFilterExpression: { reportState: { $exists: true } } });
  // Open streams waiting for "End stream" or the four-hour idle close.
  await ctx.users.createIndex({ "streamSession.startAt": 1 }, { sparse: true });
  await ctx.users.createIndex({ "calendarFeed.hash": 1 }, { unique: true, sparse: true });
  await ctx.discordHooks.createIndex({ userId: 1, createdAt: 1 });
  await ctx.discordHooks.createIndex({ enabled: 1, status: 1 });
  await ctx.discordHooks.createIndex({ userId: 1, connectIdentity: 1 }, { unique: true, partialFilterExpression: { connectIdentity: { $type: "string" } } });
  await ctx.discordHooks.createIndex({ userId: 1, connectSlot: 1 }, { unique: true, partialFilterExpression: { connectSlot: { $type: "number" } } });
  await ctx.discordOutbox.createIndex({ dedupeKey: 1 }, { unique: true });
  await ctx.discordOutbox.createIndex({ status: 1, nextAttemptAt: 1 });
  await ctx.discordOutbox.createIndex({ hookId: 1 });
  await ctx.discordOutbox.createIndex({ userId: 1 });
  await ctx.discordOutbox.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await ctx.pushSubscriptions.createIndex({ endpointHash: 1 }, { unique: true });
  await ctx.pushSubscriptions.createIndex({ userId: 1, createdAt: -1 });
}

module.exports = { connect, ensureIndexes, attachSlowQueryLogging };

/** @param {import("mongodb").Db} db */
function donationCollections(db) {
  return {
    supporters: db.collection(COLLECTIONS.SUPPORTERS),
    donationMonths: db.collection(COLLECTIONS.DONATION_MONTHS),
  };
}

/** @param {Pick<ReturnType<typeof donationCollections>, "supporters"> & {playerChannels: import("mongodb").Collection}} ctx */
async function ensureDirectoryIndexes(ctx) {
  await ctx.playerChannels.createIndex({ id: 1 }, { unique: true });
  // Tombstones retain their identities so a refresh cannot resurrect removed channels.
  await ctx.playerChannels.createIndex({ identityKeys: 1 }, { unique: true });
  await ctx.playerChannels.createIndex({ ownerUserId: 1 }, { sparse: true });
  await ctx.playerChannels.createIndex({ removed: 1, displayName: 1, id: 1 });
  await ctx.playerChannels.createIndex({ pending: 1, removed: 1 });
  await ctx.supporters.createIndex({ userId: 1 }, { unique: true });
  await ctx.supporters.createIndex({ status: 1, month: -1, reviewedAt: -1 });
}
