"use strict";

require("dotenv").config();

const http = require("http");
const { startJobMonitor } = require("./util/jobLedger");
const pinoModule = require("pino");
const { Server: IoServer } = require("socket.io");

const pino = /** @type {any} */ (pinoModule).default || pinoModule;

const { loadConfig } = require("./config/loader");
const { connect } = require("./db/connect");
const { buildApp } = require("./app");
const { attachSocketAuth } = require("./socket/auth");
const { buildKeepaliveWorker } = require("./services/keepalive");
const { buildSessionRefresher } = require("./services/sessionRefresher");
const { SupportEmailService, buildSupportEmailJob } = require("./services/supportEmail");
const {
  RuntimeCapacityRegistry,
  buildRuntimeCapacityMonitor,
} = require("./services/runtimeCapacity");
const { buildPulseBackfillJob } = require("./jobs/pulseBackfillJob");
const {
  buildOpponentMmrEnrichmentJob,
} = require("./jobs/opponentMmrEnrichmentJob");
const { buildLadderMapPoolRefreshJob } = require("./jobs/ladderMapPoolRefreshJob");
const { buildLadderMapBackfillJob } = require("./jobs/ladderMapBackfillJob");
const {
  buildLeaguePercentilesRecomputeJob,
} = require("./jobs/leaguePercentilesRecomputeJob");
const { buildMmrExpectationRecomputeJob } = require("./jobs/mmrExpectationRecomputeJob");
const {
  buildFingerprintPopulationCalibrationRecomputeJob,
} = require("./jobs/fingerprintPopulationCalibrationRecomputeJob");
const {
  buildLadderMetaRecomputeJob,
} = require("./jobs/ladderMetaRecomputeJob");
const { buildReviewDigestJob } = require("./jobs/reviewDigestJob");
const { buildBackupHealthJob } = require("./jobs/backupHealthJob");
const { buildIdentityDeletionJob } = require("./jobs/identityDeletionJob");
const sentry = require("./util/sentry");
const { TrendsExplorerBackfill } = require("./services/trendsExplorerBackfill");
const { startBrowserUploadCorsCheck } = require("./services/replayFilesCors");

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  // Initialise Sentry early so anything thrown during bootstrap is
  // captured. Log the resolved state once — "I set SENTRY_DSN, why is
  // Sentry empty?" is only debuggable from Render logs.
  const sentryEnabled = sentry.init();
  logger.info(
    { sentry: sentryEnabled ? "enabled" : "disabled" },
    "sentry_state",
  );
  logger.info({ port: config.port, db: config.mongoDb }, "boot_start");

  // Process-level safety nets. Express's error middleware only covers
  // the request path; rejections from background jobs, socket handlers,
  // and fire-and-forget promises land here. A rejection is logged and
  // reported but does NOT kill the process; an uncaught synchronous
  // exception means undefined state, so capture, flush, and let Render
  // restart the instance.
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled_rejection");
    sentry.captureException(reason);
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught_exception");
    sentry.captureException(err);
    void sentry.flush().finally(() => process.exit(1));
  });

  const db = await connect(
    { uri: config.mongoUri, dbName: config.mongoDb },
    { logger, slowQueryMs: config.slowQueryMs },
  );
  logger.info("mongo_connected");

  const httpServer = http.createServer();
  const io = new IoServer(httpServer, {
    cors: {
      origin: config.corsAllowedOrigins.length
        ? config.corsAllowedOrigins
        : true,
    },
  });

  const runtimeCapacityRegistry = new RuntimeCapacityRegistry();
  const { app, services, adminClerkIds } = /** @type {{
    app: import('express').Express,
    services: {
      overlayTokens: import('./services/types').OverlayTokensService,
      games: import('./services/types').GamesService,
      opponents: import('./services/opponents').OpponentsService,
      [k: string]: unknown,
    },
    adminClerkIds: Set<string>,
  }} */ (buildApp({
    db,
    logger,
    config,
    io,
    runtimeCapacityRegistry,
  }));
  httpServer.on("request", app);
  // Admin allowlist shared by the REST gate (built inside buildApp
  // from SC2TOOLS_ADMIN_USER_IDS) and the socket layer below —
  // mutations here are visible to both, they read the live set.
  //
  // Merge persisted DB admins into the allowlist at boot: admins minted
  // by the email allowlist (SC2TOOLS_ADMIN_EMAILS) or an explicit grant
  // carry role:"admin" on their user doc, and this re-seeds the live set
  // so they stay admin across restarts. Failures are non-fatal — the
  // env-var allowlists keep working without it.
  try {
    const dbAdminIds = await /** @type {any} */ (services).users.listDbAdminClerkIds();
    for (const id of dbAdminIds) adminClerkIds.add(id);
    if (dbAdminIds.length > 0) {
      logger.info(
        { count: dbAdminIds.length },
        "admin_allowlist_merged_from_db",
      );
    }
  } catch (err) {
    logger.error({ err }, "admin_allowlist_merge_failed");
  }
  attachSocketAuth(io, {
    secretKey: config.clerkSecretKey,
    issuer: config.clerkJwtIssuer,
    audience: config.clerkJwtAudience,
    isAdminClerkId: (clerkUserId) => adminClerkIds.has(clerkUserId),
    resolveOverlayToken: (token) => services.overlayTokens.resolve(token),
    isOverlayTokenReplaced: (token) => services.overlayTokens.isReplaced(token),
    validateOverlayToken: (userId, token) =>
      services.overlayTokens.tokenBelongsToUser(userId, token),
    resolveDeviceToken: (tokenHash) =>
      /** @type {any} */ (services).pairings.findTokenByHash(tokenHash),
    // Same Clerk → internal userId map the REST middleware uses, so a
    // dashboard tab's websocket joins ``user:<userId>`` on handshake
    // and receives per-user fan-outs (games:changed → live opponents
    // refresh, import:progress, macro:recompute_request) without
    // having to claim its own userId via subscribe:user.
    resolveClerkUser: (clerkUserId) =>
      /** @type {any} */ (services).users.ensureFromClerk(clerkUserId),
    resolveSession: (userId, timezone) =>
      services.games.todaySession(userId, timezone, { reuseRecent: true }),
    resolveVoicePrefs: (userId) =>
      /** @type {any} */ (services).users.getPreferences(userId, "voice"),
    resolveRandomizerPrefs: (userId) =>
      /** @type {any} */ (services).buildIntents.overlayRandomizerConfig(userId),
    resolveGhostPrefs: (userId) => /** @type {any} */ (services).ghostConfig.get(userId),
    // Build check-in: the current live game's hold / suppress state (no
    // build names), replayed to overlays on connect and resync, and the
    // randomizer widget's roll reports.
    resolveBuildIntent: (userId) =>
      /** @type {any} */ (services).buildIntents.overlayStateForCurrentGame(userId),
    onRandomizerRolled: (userId, token, payload) =>
      /** @type {any} */ (services).buildIntents.handleRandomizerRoll(userId, token, payload),
    // Replayed to Browser Sources on connect/resync. Live Stream Dock pushes
    // are still immediate; this persisted read closes the reconnect gap for
    // the manual Starting Soon / BRB cover.
    resolveStudioState: (token) =>
      /** @type {any} */ (services).multichatStudio.get(token),
    resolvePlatformEvents: (userId) =>
      /** @type {any} */ (services).platformIntegrations.recentEvents(userId),
    // Synchronous broker-snapshot accessor used by the overlay
    // connect-replay path AND the ``overlay:resync`` /
    // ``overlay:heartbeat`` handlers. Returns the latest
    // ``overlay:liveGame`` envelope (with synthetic prelude when the
    // cached state is past the loading screen), the latest cached
    // ``overlay:live`` post-game payload, and the broker's current
    // gameKey for heartbeat-driven drift detection. Fully in-memory
    // — no Mongo round-trip on the connect path.
    resolveLiveSnapshot: (userId) => {
      const broker =
        /** @type {any} */ (services).liveGameBroker;
      if (!broker) return null;
      const replay = broker.replayLatestForOverlay(userId);
      const overlayLive = broker.latestOverlayLive(userId);
      const gameKey = broker.currentGameKey(userId);
      return {
        prelude: replay.prelude,
        envelope: replay.envelope,
        overlayLive,
        gameKey,
      };
    },
  });

  // Saving a custom build returns immediately while its full-history rule
  // scan runs in one memory-bounded background lane. Resume jobs left queued
  // or interrupted by a deploy before accepting new requests.
  try {
    await /** @type {any} */ (services).customBuilds
      .recoverQueuedReclassifications();
  } catch (err) {
    logger.error({ err }, "custom_build_reclassify_recovery_failed");
  }

  const runtimeCapacity = buildRuntimeCapacityMonitor({
    logger,
    io,
    registry: runtimeCapacityRegistry,
  });
  httpServer.listen(config.port, () => {
    logger.info({ port: config.port }, "listening");
    runtimeCapacity.start();
    /** @type {any} */ (services).platformIntegrations.start();
    // Browser replay backups PUT straight to the private R2 bucket: add and
    // verify its CORS rule in the background (never blocks or fails boot).
    void startBrowserUploadCorsCheck(
      /** @type {import('./services/replayFilesCors').BrowserUploadCorsStatus|null} */ (
        services.browserUploadCors
      ),
      logger,
    );
  });

  // Keep-alive heartbeat. Runs only when KEEPALIVE_TARGETS is configured —
  // typically the public web origin's /api/ping URL — so dev environments
  // and the test harness stay quiet by default.
  const keepalive = buildKeepaliveWorker({
    jobLedger: /** @type {any} */ (services).jobLedger,
    targets: config.keepaliveTargets,
    intervalMs: config.keepaliveIntervalMs,
    logger,
  });
  keepalive.start();

  // Direct support email shares the same durable Messages feed as in-app
  // reports. Gmail access is read-only and disabled until configured.
  const supportEmailJob = buildSupportEmailJob({
    jobLedger: /** @type {any} */ (services).jobLedger,
    service: config.supportEmail ? new SupportEmailService({
      db,
      adminEvents: /** @type {import('./services/adminEvents').AdminEventsService} */ (services.adminEvents),
      config: config.supportEmail,
    }) : null,
    intervalMs: config.supportEmail?.intervalMs,
    logger,
  });
  supportEmailJob.start();

  // Pulse-character-id backfill cron. Heals opponents rows whose
  // first ingest happened during a transient SC2Pulse outage —
  // see jobs/pulseBackfillJob.js for the lock + cycle policy.
  // Soft-disabled via SC2TOOLS_PULSE_BACKFILL_DISABLED=1.
  const pulseBackfill = buildPulseBackfillJob({
    jobLedger: /** @type {any} */ (services).jobLedger,
    db,
    opponents: services.opponents,
    logger,
  });
  pulseBackfill.start();

  // Forward-only game-level opponent MMR + league enrichment. Pulse exposes
  // current per-race ladder metadata, so this worker only considers recently
  // inserted ladder games and marks each lookup once. When it repairs league
  // rows, refresh the public aggregate immediately instead of leaving the
  // recovered sample invisible until the next nightly rebuild.
  const opponentMmrEnrichment = buildOpponentMmrEnrichmentJob({
    jobLedger: /** @type {any} */ (services).jobLedger,
    db,
    pulseMmr: /** @type {any} */ (services).pulseMmr,
    logger,
    onLeagueEnriched: async (summary) => {
      const result = await /** @type {any} */ (services).ladderMeta.recompute();
      logger.info(
        { leagueEnriched: summary.leagueEnriched, bands: result.bands },
        "ladder_meta_refreshed_after_league_enrichment",
      );
    },
  });
  opponentMmrEnrichment.start();

  // Periodic re-emit of ``overlay:session`` to every connected overlay
  // socket. The session aggregate has a 4-hour-inactivity reset baked
  // into ``GamesService.todaySession``, but that reset only takes
  // effect when somebody re-asks the service. Without this worker the
  // widget would keep showing yesterday's late-evening W-L until the
  // next game ingest — which is exactly when the streamer no longer
  // needs the reset. A 5-minute cadence keeps Mongo load bounded
  // (per-tick cache prevents fan-out per overlay) and gives the widget
  // ≤5 min latency between the inactivity threshold tripping and the
  // card resetting on screen.
  const sessionRefresher = buildSessionRefresher({
    jobLedger: /** @type {any} */ (services).jobLedger,
    io,
    games: services.games,
    logger,
  });
  sessionRefresher.start();

  // Ladder map pool refresh. Keeps /v1/seasons.mapPool aligned with
  // Blizzard's ladder rotations by re-fetching from Liquipedia every
  // 24h (configurable, soft-disable via env). Runs once on start so a
  // fresh container doesn't rely on the bundled seed for very long.
  const ladderMapPoolRefresh = buildLadderMapPoolRefreshJob({
    jobLedger: /** @type {any} */ (services).jobLedger,
    ladderMapPool: /** @type {any} */ (services).seasons.ladderMapPool,
    logger,
  });
  ladderMapPoolRefresh.start();

  // Legacy ladder-map backfill. Stamps ``isLadderMap`` on games that
  // pre-date the ingest-time classifier for compatibility/diagnostics;
  // ranked/custom analyzer filters now require authoritative
  // ``isLadderGame``. Self-skips once every game carries the field;
  // fire-and-forget
  // so it never blocks boot. Disable with
  // ``SC2TOOLS_LADDER_BACKFILL_DISABLED=1``.
  const ladderMapBackfill = buildLadderMapBackfillJob({
    jobLedger: /** @type {any} */ (services).jobLedger,
    db,
    ladderMapPool: /** @type {any} */ (services).seasons.ladderMapPool,
    logger,
  });
  ladderMapBackfill.start();

  // Nightly league-percentile benchmark rebuild (Macro tab framing).
  const leaguePercentilesJob = buildLeaguePercentilesRecomputeJob({
    jobLedger: /** @type {any} */ (services).jobLedger,
    leaguePercentiles: /** @type {any} */ (services).leaguePercentiles,
    logger,
  });
  leaguePercentilesJob.start();
  const mmrExpectationJob = buildMmrExpectationRecomputeJob({
    db, logger, jobLedger: /** @type {any} */ (services).jobLedger,
    mmrExpectation: /** @type {any} */ (services).mmrExpectation,
  });
  mmrExpectationJob.start();

  // Nightly player-level reference for Skill Fingerprint naming. This is a
  // separate table from per-game league benchmarks: each player/matchup window
  // contributes exactly one observation.
  const fingerprintPopulationCalibrationJob =
    buildFingerprintPopulationCalibrationRecomputeJob({
    jobLedger: /** @type {any} */ (services).jobLedger,
      calibration: /** @type {any} */ (services)
        .fingerprintPopulationCalibration,
      logger,
    });
  fingerprintPopulationCalibrationJob.start();

  // Nightly effectiveness-weighted ladder meta rebuild (the signed-in
  // Ladder Pulse; the old public /meta page now redirects to /guides).
  const ladderMetaJob = buildLadderMetaRecomputeJob({
    jobLedger: /** @type {any} */ (services).jobLedger,
    ladderMeta: /** @type {any} */ (services).ladderMeta,
    logger,
  });
  ladderMetaJob.start();

  // SC2 Tools Guides nightly guide_stats rebuild (+ web ISR revalidation).
  // First check 15 min after boot (after ladderMeta's boot rebuild), then
  // hourly; it only recomputes once the last run is ~a day old. Only
  // started with GUIDES_ENABLED; built (never started) in makeServices.
  const guideStatsJob = /** @type {any} */ (services).guideStatsJob;
  if (config.guidesEnabled) guideStatsJob.start();

  // Weekly Replay Review Exchange digest (hourly check, weekly send).
  const reviewDigestJob = buildReviewDigestJob({
    jobLedger: /** @type {any} */ (services).jobLedger,
    reviews: /** @type {any} */ (services).reviews,
    logger,
    enabled: config.reviewsEnabled === "on",
  });
  reviewDigestJob.start();

  // Hourly Atlas Cloud Backup check: one admin notification per day while
  // the newest snapshot is overdue. Only with the Atlas service account.
  const backupHealthJob = buildBackupHealthJob({
    jobLedger: /** @type {any} */ (services).jobLedger,
    backupStatus: /** @type {any} */ (services).backupStatus,
    logger,
  });
  backupHealthJob.start();
  const identityDeletionJob = buildIdentityDeletionJob({ jobLedger: /** @type {any} */ (services).jobLedger, service: /** @type {any} */ (services).identityDeletions, logger });
  identityDeletionJob.start();

  // SC2 Tools Guides build-order videos: seed the committed channel
  // snapshot, then re-read the owner's YouTube RSS feed every 6 h. Only
  // with guides on (GUIDES_ENABLED) and a channel id configured.
  const guideVideosJob = /** @type {any} */ (services).guideVideosJob;
  if (config.guidesEnabled && config.guidesYoutubeChannelId) {
    guideVideosJob.start();
  }

  // Derive compact chart facts from existing replay details in small batches.
  // Normal uploads maintain these facts atomically; no reupload is needed.
  const trendsExplorerBackfill = new TrendsExplorerBackfill({
    jobLedger: /** @type {any} */ (services).jobLedger,
    db, gameDetails: /** @type {any} */ (services).gameDetails, logger,
  });
  trendsExplorerBackfill.start();
  const stopJobMonitor = startJobMonitor(/** @type {any} */ (services).jobLedger);

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  /** @param {string} signal */
  async function shutdown(signal) {
    logger.info({ signal }, "shutdown_start");
    runtimeCapacity.stop();
    stopJobMonitor();
    await trendsExplorerBackfill.stop();
    await /** @type {any} */ (services).platformIntegrations.stop();
    // True drain, in order: stop accepting connections, let in-flight
    // requests finish, THEN close Mongo — the old fire-and-forget
    // close() left handlers mid-query when the client shut down. Long-
    // lived streams (the /v1/me/live SSE) hold close() open, so after
    // a grace period we force-close whatever sockets remain.
    const drained = new Promise((resolve) => {
      httpServer.close(() => resolve(true));
    });
    io.close();
    httpServer.closeIdleConnections?.();
    const graceMs = 8000;
    const timedOut = await Promise.race([
      drained.then(() => false),
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(true), graceMs);
        if (typeof t.unref === "function") t.unref();
      }),
    ]);
    if (timedOut) {
      logger.warn({ graceMs }, "shutdown_forcing_remaining_connections");
      httpServer.closeAllConnections?.();
      await drained;
    }
    await keepalive.stop();
    await supportEmailJob.stop();
    await pulseBackfill.stop();
    await opponentMmrEnrichment.stop();
    await sessionRefresher.stop();
    await ladderMapPoolRefresh.stop();
    await ladderMapBackfill.stop();
    await leaguePercentilesJob.stop();
    await mmrExpectationJob.stop();
    await fingerprintPopulationCalibrationJob.stop();
    await ladderMetaJob.stop();
    await reviewDigestJob.stop();
    await backupHealthJob.stop();
    await identityDeletionJob.stop();
    // Also waits for an admin-forced run when the schedule never started.
    await guideStatsJob.stop();
    // Admin-triggered guide backfill (never started at boot) and any
    // in-flight fire-and-forget guide sample writes, before Mongo closes.
    await /** @type {any} */ (services).guideSamplesBackfill.stop();
    await /** @type {any} */ (services).guideSamples.drain();
    await /** @type {any} */ (services).gdpr.backups?.drain();
    await /** @type {any} */ (services).dataRepairs.drain();
    await guideVideosJob.stop();
    await /** @type {any} */ (services).customBuilds.stopReclassifications();
    await db.close();
    logger.info("shutdown_complete");
    process.exit(0);
  }
}

main().catch((err) => {
  sentry.captureException(err);
  console.error("fatal_boot_error", err);
  process.exit(1);
});
