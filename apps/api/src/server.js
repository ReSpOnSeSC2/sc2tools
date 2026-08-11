"use strict";

require("dotenv").config();

const http = require("http");
const pinoModule = require("pino");
const { Server: IoServer } = require("socket.io");

const pino = /** @type {any} */ (pinoModule).default || pinoModule;

const { loadConfig } = require("./config/loader");
const { connect } = require("./db/connect");
const { buildApp } = require("./app");
const { attachSocketAuth } = require("./socket/auth");
const { buildKeepaliveWorker } = require("./services/keepalive");
const { buildSessionRefresher } = require("./services/sessionRefresher");
const { buildPulseBackfillJob } = require("./jobs/pulseBackfillJob");
const {
  buildOpponentMmrEnrichmentJob,
} = require("./jobs/opponentMmrEnrichmentJob");
const { buildLadderMapPoolRefreshJob } = require("./jobs/ladderMapPoolRefreshJob");
const { buildLadderMapBackfillJob } = require("./jobs/ladderMapBackfillJob");
const {
  buildLeaguePercentilesRecomputeJob,
} = require("./jobs/leaguePercentilesRecomputeJob");
const {
  buildLadderMetaRecomputeJob,
} = require("./jobs/ladderMetaRecomputeJob");
const sentry = require("./util/sentry");

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

  const { app, services, adminClerkIds } = /** @type {{
    app: import('express').Express,
    services: {
      overlayTokens: import('./services/types').OverlayTokensService,
      games: import('./services/types').GamesService,
      opponents: import('./services/opponents').OpponentsService,
      [k: string]: unknown,
    },
    adminClerkIds: Set<string>,
  }} */ (buildApp({ db, logger, config, io }));
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
      services.games.todaySession(userId, timezone),
    resolveVoicePrefs: (userId) =>
      /** @type {any} */ (services).users.getPreferences(userId, "voice"),
    resolveRandomizerPrefs: (userId) =>
      /** @type {any} */ (services).users.getPreferences(userId, "randomizer"),
    // Replayed to Browser Sources on connect/resync. Live Stream Dock pushes
    // are still immediate; this persisted read closes the reconnect gap for
    // the manual Starting Soon / BRB cover.
    resolveStudioState: (token) =>
      /** @type {any} */ (services).multichatStudio.get(token),
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

  httpServer.listen(config.port, () => {
    logger.info({ port: config.port }, "listening");
  });

  // Keep-alive heartbeat. Runs only when KEEPALIVE_TARGETS is configured —
  // typically the public web origin's /api/ping URL — so dev environments
  // and the test harness stay quiet by default.
  const keepalive = buildKeepaliveWorker({
    targets: config.keepaliveTargets,
    intervalMs: config.keepaliveIntervalMs,
    logger,
  });
  keepalive.start();

  // Pulse-character-id backfill cron. Heals opponents rows whose
  // first ingest happened during a transient SC2Pulse outage —
  // see jobs/pulseBackfillJob.js for the lock + cycle policy.
  // Soft-disabled via SC2TOOLS_PULSE_BACKFILL_DISABLED=1.
  const pulseBackfill = buildPulseBackfillJob({
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
    db,
    ladderMapPool: /** @type {any} */ (services).seasons.ladderMapPool,
    logger,
  });
  ladderMapBackfill.start();

  // Nightly league-percentile benchmark rebuild (Macro tab framing).
  const leaguePercentilesJob = buildLeaguePercentilesRecomputeJob({
    leaguePercentiles: /** @type {any} */ (services).leaguePercentiles,
    logger,
  });
  leaguePercentilesJob.start();

  // Nightly effectiveness-weighted ladder meta rebuild (public /meta).
  const ladderMetaJob = buildLadderMetaRecomputeJob({
    ladderMeta: /** @type {any} */ (services).ladderMeta,
    logger,
  });
  ladderMetaJob.start();

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  /** @param {string} signal */
  async function shutdown(signal) {
    logger.info({ signal }, "shutdown_start");
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
    await pulseBackfill.stop();
    await opponentMmrEnrichment.stop();
    await sessionRefresher.stop();
    await ladderMapPoolRefresh.stop();
    await ladderMapBackfill.stop();
    await leaguePercentilesJob.stop();
    await ladderMetaJob.stop();
    await db.close();
    logger.info("shutdown_complete");
    process.exit(0);
  }
}

main().catch((err) => {
  sentry.captureException(err);
  // eslint-disable-next-line no-console
  console.error("fatal_boot_error", err);
  process.exit(1);
});
