"use strict";

const { DEFAULTS } = require("./constants");

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;

const VALID_GAME_DETAILS_STORES = new Set(["mongo", "r2"]);

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
 *   adminEmails: string[],
 *   keepaliveTargets: string[],
 *   keepaliveIntervalMs: number,
 *   slowQueryMs: number,
 *   metricsToken: string|null,
 *   gameDetailsStore: "mongo"|"r2",
 *   r2: {
 *     endpoint: string,
 *     region: string,
 *     bucket: string,
 *     accessKeyId: string,
 *     secretAccessKey: string,
 *     prefix: string,
 *   }|null,
 *   analytics: {
 *     enabled: boolean,
 *     propertyId: string|null,
 *     credentials: { client_email: string, private_key: string }|null,
 *     keyFile: string|null,
 *   },
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
  // Fail fast instead of silently reflecting any origin: both the
  // Express CORS middleware and the Socket.io server fall back to
  // allow-all when the allowlist is empty. Fine for dev/test; a
  // misconfigured production deploy must not boot that way.
  const corsAllowedOrigins = parseCsv(env.CORS_ALLOWED_ORIGINS);
  if ((env.NODE_ENV || "development") === "production"
    && corsAllowedOrigins.length === 0) {
    throw new Error(
      "CORS_ALLOWED_ORIGINS must be set in production — an empty "
      + "allowlist makes the API reflect any origin",
    );
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
    corsAllowedOrigins,
    rateLimitPerMinute: parseInteger(
      env.RATE_LIMIT_PER_MINUTE,
      DEFAULTS.RATE_LIMIT_PER_MINUTE,
    ),
    agentReleaseAdminToken: env.AGENT_RELEASE_ADMIN_TOKEN || null,
    pythonExe: env.SC2_PY_PYTHON || null,
    pythonAnalyzerDir: env.SC2_PY_ANALYZER_DIR || null,
    adminUserIds: parseCsv(env.SC2TOOLS_ADMIN_USER_IDS),
    // Email allowlist — the deterministic, operator-controlled way to
    // mint admins. Any signed-in user whose verified Clerk email matches
    // (case-insensitively) is granted the admin role the first time we
    // see their email, and that grant is persisted + merged into the
    // live allowlist. CSV of emails; normalised to lower-case here so
    // matching is case-insensitive.
    adminEmails: parseCsv(env.SC2TOOLS_ADMIN_EMAILS).map((e) =>
      e.toLowerCase(),
    ),
    keepaliveTargets: parseCsv(env.KEEPALIVE_TARGETS),
    keepaliveIntervalMs: parseInteger(
      env.KEEPALIVE_INTERVAL_MS,
      DEFAULTS.KEEPALIVE_INTERVAL_MS,
    ),
    // Mongo commands slower than this (ms) are logged as slow_query.
    slowQueryMs: parseInteger(env.SLOW_QUERY_MS, 100),
    // Bearer token guarding GET /v1/metrics (Prometheus scrape).
    // Unset = endpoint disabled.
    metricsToken: env.METRICS_TOKEN || null,
    gameDetailsStore: parseGameDetailsStore(env.GAME_DETAILS_STORE),
    r2: parseR2Config(env),
    analytics: parseAnalyticsConfig(env),
  };
}

/**
 * Parse the Google Analytics 4 Data API block.
 *
 * The admin Analytics tab reads real GA4 metrics server-side via the
 * Data API, which authenticates as a Google Cloud service account.
 * Two credential delivery shapes are supported; whichever is set wins:
 *
 *   - ``GA_SERVICE_ACCOUNT_KEY_B64`` — the service-account JSON key,
 *     base64-encoded into a single env var. Best for Vercel/serverless
 *     where you can't ship a file. Decoded + parsed here.
 *   - ``GOOGLE_APPLICATION_CREDENTIALS`` — a path to the JSON key file
 *     on disk. The google-auth library picks this up automatically via
 *     Application Default Credentials, so we only need to note that a
 *     credential source exists.
 *
 * Returns ``{ enabled: false }`` when no property id is configured, so
 * the API boots fine without GA wired up (the admin tab then renders a
 * "not configured" setup hint instead of 500ing). ``enabled`` only
 * flips true when we have BOTH a property id and a credential source.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   enabled: boolean,
 *   propertyId: string|null,
 *   credentials: { client_email: string, private_key: string }|null,
 *   keyFile: string|null,
 * }}
 */
function parseAnalyticsConfig(env) {
  const propertyId = (env.GA4_PROPERTY_ID || "").trim() || null;
  const keyFile = (env.GOOGLE_APPLICATION_CREDENTIALS || "").trim() || null;
  const credentials = parseServiceAccountKey(env.GA_SERVICE_ACCOUNT_KEY_B64);
  const enabled = Boolean(propertyId && (credentials || keyFile));
  return { enabled, propertyId, credentials, keyFile };
}

/**
 * Decode + validate a base64-encoded service-account JSON key. Throws
 * a precise error (rather than a downstream auth failure) when the var
 * is set but malformed, so a typo fails fast at boot. Returns ``null``
 * when the var is absent — that's a valid state (the operator may be
 * using a key FILE via GOOGLE_APPLICATION_CREDENTIALS instead).
 *
 * @param {string|undefined} raw
 * @returns {{ client_email: string, private_key: string }|null}
 */
function parseServiceAccountKey(raw) {
  if (!raw || raw.trim() === "") return null;
  let json;
  try {
    json = Buffer.from(raw.trim(), "base64").toString("utf8");
  } catch {
    throw new Error("GA_SERVICE_ACCOUNT_KEY_B64 is not valid base64");
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      "GA_SERVICE_ACCOUNT_KEY_B64 did not decode to valid JSON — re-encode the service-account key file",
    );
  }
  if (!parsed || typeof parsed !== "object" || !parsed.client_email || !parsed.private_key) {
    throw new Error(
      "GA_SERVICE_ACCOUNT_KEY_B64 is missing client_email / private_key — is this a service-account key?",
    );
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

/**
 * Validate the GAME_DETAILS_STORE env var. Defaults to ``mongo`` so a
 * fresh deploy always starts with the safe in-database backend; flip
 * to ``r2`` once the bucket is provisioned and the migration script
 * has copied existing detail rows over.
 *
 * @param {string|undefined} raw
 * @returns {"mongo"|"r2"}
 */
function parseGameDetailsStore(raw) {
  const v = (raw || "mongo").trim().toLowerCase();
  if (!VALID_GAME_DETAILS_STORES.has(v)) {
    throw new Error(
      `GAME_DETAILS_STORE must be one of [mongo, r2]; got: ${raw}`,
    );
  }
  // The Set guard above proves membership; TS can't narrow through it.
  return /** @type {"mongo"|"r2"} */ (v);
}

/**
 * Pull the R2 / S3 connection block out of env. Returns ``null``
 * when no R2 endpoint is configured — which is the right state for
 * the default ``mongo`` backend. ``buildStoreFromConfig`` enforces
 * the full set of vars when the store is explicitly switched to R2,
 * so a partial configuration fails loudly rather than silently
 * falling back to mongo.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function parseR2Config(env) {
  const endpoint = env.R2_ENDPOINT || "";
  if (!endpoint) return null;
  return {
    endpoint,
    region: env.R2_REGION || "auto",
    bucket: env.R2_BUCKET || "",
    accessKeyId: env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY || "",
    prefix: env.R2_PREFIX || "game-details",
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

module.exports = {
  loadConfig,
  parseGameDetailsStore,
  parseR2Config,
  parseAnalyticsConfig,
};
