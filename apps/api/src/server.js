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
const { buildLadderMapPoolRefreshJob } = require("./jobs/ladderMapPoolRefreshJob");
const sentry = require("./util/sentry");

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  // Initialise Sentry early so anything thrown during bootstrap is
  // captured. No-op when SENTRY_DSN is unset or @sentry/node isn't
  // installed yet.
  sentry.init();
  logger.info({ port: config.port, db: config.mongoDb }, "boot_start");

  const db = await connect({ uri: config.mongoUri, dbName: config.mongoDb });
  logger.info("mongo_connected");

  const httpServer = http.createServer();
  const io = new IoServer(httpServer, {
    cors: {
      origin: config.corsAllowedOrigins.length
        ? config.corsAllowedOrigins
        : true,
    },
  });

  const { app, services } = /** @type {{
    app: import('express').Express,
    services: {
      overlayTokens: import('./services/types').OverlayTokensService,
      games: import('./services/types').GamesService,
      opponents: import('./services/opponents').OpponentsService,
      [k: string]: unknown,
    },
  }} */ (buildApp({ db, logger, config, io }));
  httpServer.on("request", app);
  attachSocketAuth(io, {
    secretKey: config.clerkSecretKey,
    issuer: config.clerkJwtIssuer,
    audience: config.clerkJwtAudience,
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

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  /** @param {string} signal */
  async function shutdown(signal) {
    logger.info({ signal }, "shutdown_start");
    httpServer.close();
    io.close();
    await keepalive.stop();
    await pulseBackfill.stop();
    await sessionRefresher.stop();
    await ladderMapPoolRefresh.stop();
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
