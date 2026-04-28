"use strict";

require("dotenv").config();

const { loadConfig } = require("./src/config");
const { createLogger } = require("./src/logger");
const { connect } = require("./src/db");
const { buildApp } = require("./src/app");

/**
 * Bootstraps the service. Connects to MongoDB, builds the app, listens.
 * Exits non-zero on fatal startup errors.
 */
async function main() {
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.logLevel, nodeEnv: cfg.nodeEnv });
  try {
    const db = await connect({ uri: cfg.mongoUri, dbName: cfg.mongoDb });
    const app = buildApp({
      db,
      logger,
      pepper: cfg.serverPepper,
      trustProxy: cfg.trustProxy,
      corsAllowedOrigins: cfg.corsAllowedOrigins,
    });
    const server = app.listen(cfg.port, () => {
      logger.info({ port: cfg.port, env: cfg.nodeEnv }, "service_listening");
    });
    setupShutdown(server, db, logger);
  } catch (err) {
    logger.fatal({ err }, "startup_failed");
    process.exitCode = 1;
  }
}

/**
 * @param {import('http').Server} server
 * @param {{ close: () => Promise<unknown> }} db
 * @param {import('pino').Logger} logger
 */
function setupShutdown(server, db, logger) {
  /** @param {string} signal */
  const stop = async (signal) => {
    logger.info({ signal }, "shutdown_starting");
    server.close(() => logger.info("http_server_closed"));
    await db.close();
    logger.info("db_closed");
  };
  process.on("SIGTERM", () => { void stop("SIGTERM"); });
  process.on("SIGINT", () => { void stop("SIGINT"); });
}

if (require.main === module) {
  void main();
}

module.exports = { main };
