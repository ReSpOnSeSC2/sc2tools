"use strict";

const pinoModule = require("pino");
const { SERVICE } = require("./constants");

const pino = /** @type {any} */ (pinoModule).default || pinoModule;

/**
 * Build a structured pino logger with sane defaults.
 * Redacts known sensitive fields so PII never reaches transport.
 *
 * @param {{ level?: string, nodeEnv?: string }} [opts]
 * @returns {import('pino').Logger}
 *
 * Example:
 *   const log = createLogger({ level: "info" });
 *   log.info({ buildId: "abc" }, "build created");
 */
function createLogger(opts = {}) {
  const level = opts.level || "info";
  const isProd = (opts.nodeEnv || "development") === "production";
  return pino({
    level,
    name: SERVICE.NAME,
    base: { service: SERVICE.NAME, version: SERVICE.VERSION },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      /** @param {string} label */
      level(label) {
        return { level: label };
      },
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers['x-client-signature']",
        "body.token",
        "body.refreshToken",
        "body.battle_tag",
      ],
      censor: "[redacted]",
    },
    transport: isProd ? undefined : {
      target: "pino/file",
      options: { destination: 1 },
    },
  });
}

module.exports = { createLogger };
