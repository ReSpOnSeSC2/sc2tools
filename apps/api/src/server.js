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
const { buildPulseBackfillJob } = require("./jobs/pulseBackfillJob");
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
    resolveSession: (userId, timezone) =>
      services.games.todaySession(userId, timezone),
    resolveVoicePrefs: (userId) =>
      /** @type {any} */ (services).users.getPreferences(userId, "voice"),
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

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  /** @param {string} signal */
  async function shutdown(signal) {
    logger.info({ signal }, "shutdown_start");
    httpServer.close();
    io.close();
    await keepalive.stop();
    await pulseBackfill.stop();
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
