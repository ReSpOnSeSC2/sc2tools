"use strict";

const { DEFAULTS } = require("./constants");

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Read and validate runtime configuration from process.env.
 *
 * Throws on missing required vars so the server fails fast at boot
 * rather than 500ing on every request.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   port: number,
 *   nodeEnv: string,
 *   logLevel: string,
 *   mongoUri: string,
 *   mongoDb: string,
 *   clerkSecretKey: string,
 *   clerkJwtIssuer: string|undefined,
 *   clerkJwtAudience: string|undefined,
 *   clerkWebhookSecret: string|null,
 *   serverPepper: Buffer,
 *   corsAllowedOrigins: string[],
 *   rateLimitPerMinute: number,
 *   agentReleaseAdminToken: string|null,
 *   pythonExe: string|null,
 *   pythonAnalyzerDir: string|null,
 *   adminUserIds: string[],
 *   keepaliveTargets: string[],
 *   keepaliveIntervalMs: number,
 * }}
 *
 * Example:
 *   const cfg = loadConfig();
 */
function loadConfig(env = process.env) {
  const mongoUri = requireEnv(env, "MONGODB_URI");
  const clerkSecretKey = requireEnv(env, "CLERK_SECRET_KEY");
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
    clerkSecretKey,
    clerkJwtIssuer: env.CLERK_JWT_ISSUER || undefined,
    clerkJwtAudience: env.CLERK_JWT_AUDIENCE || undefined,
    clerkWebhookSecret: env.CLERK_WEBHOOK_SECRET || null,
    serverPepper: Buffer.from(pepperHex, "hex"),
    corsAllowedOrigins: parseCsv(env.CORS_ALLOWED_ORIGINS),
    rateLimitPerMinute: parseInteger(
      env.RATE_LIMIT_PER_MINUTE,
      DEFAULTS.RATE_LIMIT_PER_MINUTE,
    ),
    agentReleaseAdminToken: env.AGENT_RELEASE_ADMIN_TOKEN || null,
    pythonExe: env.SC2_PY_PYTHON || null,
    pythonAnalyzerDir: env.SC2_PY_ANALYZER_DIR || null,
    adminUserIds: parseCsv(env.SC2TOOLS_ADMIN_USER_IDS),
    keepaliveTargets: parseCsv(env.KEEPALIVE_TARGETS),
    keepaliveIntervalMs: parseInteger(
      env.KEEPALIVE_INTERVAL_MS,
      DEFAULTS.KEEPALIVE_INTERVAL_MS,
    ),
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
