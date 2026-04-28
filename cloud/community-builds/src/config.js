"use strict";

const { DEFAULTS } = require("./constants");

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Read and validate runtime configuration from process.env.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   port: number,
 *   nodeEnv: string,
 *   logLevel: string,
 *   mongoUri: string,
 *   mongoDb: string,
 *   serverPepper: Buffer,
 *   trustProxy: number,
 *   corsAllowedOrigins: string[],
 * }}
 *
 * Example:
 *   const cfg = loadConfig();
 *   console.log(cfg.port);
 */
function loadConfig(env = process.env) {
  const mongoUri = requireEnv(env, "MONGODB_URI");
  const pepperHex = requireEnv(env, "SERVER_PEPPER_HEX");
  if (!HEX_64_REGEX.test(pepperHex)) {
    throw new Error("SERVER_PEPPER_HEX must be 64 hex characters (32 bytes)");
  }
  return {
    port: parseInteger(env.PORT, DEFAULTS.PORT),
    nodeEnv: env.NODE_ENV || "development",
    logLevel: env.LOG_LEVEL || DEFAULTS.LOG_LEVEL,
    mongoUri,
    mongoDb: env.MONGODB_DB || DEFAULTS.DB_NAME,
    serverPepper: Buffer.from(pepperHex, "hex"),
    trustProxy: parseInteger(env.TRUST_PROXY, 1),
    corsAllowedOrigins: parseCsv(env.CORS_ALLOWED_ORIGINS),
  };
}

/** @param {NodeJS.ProcessEnv} env @param {string} name @returns {string} */
function requireEnv(env, name) {
  const value = env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/** @param {string|undefined} raw @param {number} fallback @returns {number} */
function parseInteger(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Env var must be an integer, got: ${raw}`);
  }
  return parsed;
}

/** @param {string|undefined} raw @returns {string[]} */
function parseCsv(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

module.exports = { loadConfig };
