"use strict";

const { DEFAULTS } = require("./constants");

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;

const VALID_GAME_DETAILS_STORES = new Set(["mongo", "r2"]);
const VALID_REPLAY_FILES_STORES = new Set(["disabled", "r2"]);

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
 *   replayIngestMaxActive: number,
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
 *   replayFilesStore: "disabled"|"r2",
 *   r2: {
 *     endpoint: string,
 *     region: string,
 *     bucket: string,
 *     accessKeyId: string,
 *     secretAccessKey: string,
 *     prefix: string,
 *     replayPrefix: string,
 *     alertMediaBucket: string,
 *     alertMediaPrefix: string,
 *     alertMediaAccessKeyId: string,
 *     alertMediaSecretAccessKey: string,
 *     alertMediaExpiresSec: number,
 *   }|null,
 *   cloudflareAnalytics: {
 *     accountId: string,
 *     apiToken: string,
 *     bucket: string,
 *     billingCycleDay: number,
 *   }|null,
 *   atlasAdmin: {
 *     clientId: string,
 *     clientSecret: string,
 *     orgId: string,
 *     projectId: string,
 *     clusterName: string,
 *     secretExpiresAt: string|null,
 *   }|null,
 *   renderAdmin: {
 *     apiKey: string,
 *     serviceId: string,
 *     monthlyCostUsd: number|null,
 *   }|null,
 *   analytics: {
 *     enabled: boolean,
 *     propertyId: string|null,
 *     credentials: { client_email: string, private_key: string }|null,
 *     keyFile: string|null,
 *   },
 *   platformIntegrations: ReturnType<typeof parsePlatformIntegrationsConfig>,
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
    replayIngestMaxActive: parsePositiveInteger(
      env.REPLAY_INGEST_MAX_ACTIVE,
      DEFAULTS.REPLAY_INGEST_MAX_ACTIVE,
      "REPLAY_INGEST_MAX_ACTIVE",
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
    replayFilesStore: parseReplayFilesStore(env.REPLAY_FILES_STORE),
    r2: parseR2Config(env),
    cloudflareAnalytics: parseCloudflareAnalyticsConfig(env),
    atlasAdmin: parseAtlasAdminConfig(env),
    renderAdmin: parseRenderAdminConfig(env),
    analytics: parseAnalyticsConfig(env),
    platformIntegrations: parsePlatformIntegrationsConfig(env),
  };
}

/**
 * Official account connections are optional as a feature, but each provider
 * is all-or-none. A dedicated encryption key is mandatory as soon as any
 * provider is enabled; it is intentionally unrelated to SERVER_PEPPER_HEX.
 */
/** @param {NodeJS.ProcessEnv} env */
function parsePlatformIntegrationsConfig(env) {
  const apiOrigin = "https://api.sc2tools.com";
  const rawTwitchEventsubSecret = String(env.TWITCH_EVENTSUB_SECRET || "");
  const twitch = optionalProvider("Twitch", {
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
    webhookSecret: env.TWITCH_EVENTSUB_SECRET,
  }, {
    redirectUri: env.TWITCH_REDIRECT_URI
      || `${apiOrigin}/v1/integrations/twitch/callback`,
    callbackUrl: env.TWITCH_EVENTSUB_CALLBACK_URL
      || `${apiOrigin}/v1/webhooks/twitch/eventsub`,
  });
  if (twitch && !isValidTwitchEventsubSecret(rawTwitchEventsubSecret)) {
    throw new Error(
      "TWITCH_EVENTSUB_SECRET must contain 10 to 100 printable ASCII characters",
    );
  }
  if (twitch) twitch.webhookSecret = rawTwitchEventsubSecret;
  const kick = optionalProvider("Kick", {
    clientId: env.KICK_CLIENT_ID,
    clientSecret: env.KICK_CLIENT_SECRET,
  }, {
    redirectUri: env.KICK_REDIRECT_URI
      || `${apiOrigin}/v1/integrations/kick/callback`,
  });
  const youtube = optionalProvider("YouTube", {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  }, {
    redirectUri: env.GOOGLE_REDIRECT_URI
      || `${apiOrigin}/v1/integrations/youtube/callback`,
  });
  const enabled = Boolean(twitch || kick || youtube);
  const encryptionKey = String(env.PLATFORM_TOKEN_ENCRYPTION_KEY || "").trim();
  if (enabled && !isValidEncryptionKey(encryptionKey)) {
    throw new Error(
      "PLATFORM_TOKEN_ENCRYPTION_KEY must be set to 64 hex characters or base64 for exactly 32 bytes when an official platform integration is configured",
    );
  }
  return {
    enabled,
    encryptionKey: enabled ? encryptionKey : null,
    returnUrl: String(
      env.PLATFORM_INTEGRATIONS_RETURN_URL
        || "https://sc2tools.com/settings#overlay",
    ).trim(),
    youtubePollIntervalMs: parsePositiveInteger(
      env.YOUTUBE_SUBSCRIBER_POLL_INTERVAL_MS,
      5 * 60 * 1000,
      "YOUTUBE_SUBSCRIBER_POLL_INTERVAL_MS",
    ),
    providerHealthIntervalMs: parsePositiveInteger(
      env.PLATFORM_SUBSCRIPTION_HEALTH_INTERVAL_MS,
      5 * 60 * 1000,
      "PLATFORM_SUBSCRIPTION_HEALTH_INTERVAL_MS",
    ),
    twitch,
    kick,
    youtube,
  };
}

/**
 * @param {string} label
 * @param {Record<string, string|undefined>} required
 * @param {Record<string, string>} extras
 */
function optionalProvider(label, required, extras) {
  const fields = Object.fromEntries(
    Object.entries(required).map(([key, value]) => [key, String(value || "").trim()]),
  );
  const count = Object.values(fields).filter(Boolean).length;
  if (count === 0) return null;
  if (count !== Object.keys(fields).length) {
    throw new Error(`${label} official integration credentials must be set together`);
  }
  return { ...fields, ...extras };
}

/** @param {string} value */
function isValidEncryptionKey(value) {
  if (/^[0-9a-f]{64}$/i.test(value)) return true;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}

/** @param {string} value */
function isValidTwitchEventsubSecret(value) {
  if (value.length < 10 || value.length > 100) return false;
  return Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code <= 0x7e;
  });
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
 * fresh deploy always starts with the safe in-database backend; production
 * can switch to ``r2`` once the bucket is provisioned and a Full Resync is
 * scheduled to rebuild the detail objects from local replay files.
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
    replayPrefix: env.R2_REPLAY_PREFIX || "raw-replays/v1",
    // Admin-gated SC2 3D alert media. A separate private bucket from the
    // replay store, so its token can be scoped to it alone and the render
    // archive never mixes with user replay data. Leaving the bucket unset
    // disables the feature rather than failing boot; the endpoints answer 503
    // and the widget falls back to static art. See
    // docs/cloud/ALERT_MEDIA_R2.md.
    alertMediaBucket: env.R2_ALERT_MEDIA_BUCKET || "",
    alertMediaPrefix: env.R2_ALERT_MEDIA_PREFIX || "alerts/sc2-3d",
    // Optional dedicated credentials. The alert-media bucket is a different
    // bucket from the replay store, and R2 tokens are bucket-scoped, so the
    // replay token cannot read it. Setting these lets production use an
    // Object Read only token scoped to the alert bucket alone -- it signs
    // GETs and never writes. Unset falls back to the shared R2 credentials,
    // which only works if that token's scope covers this bucket too.
    alertMediaAccessKeyId: env.R2_ALERT_MEDIA_ACCESS_KEY_ID || "",
    alertMediaSecretAccessKey: env.R2_ALERT_MEDIA_SECRET_ACCESS_KEY || "",
    alertMediaExpiresSec: Number(env.R2_ALERT_MEDIA_EXPIRES_SEC) > 0
      ? Number(env.R2_ALERT_MEDIA_EXPIRES_SEC)
      : 300,
  };
}

/**
 * Optional read-only Cloudflare Analytics credentials used for the public
 * infrastructure-cost snapshot. These are deliberately separate from the R2
 * S3 access key: bucket-scoped Object Read/Write credentials cannot call the
 * Cloudflare GraphQL Analytics API.
 *
 * Account id + token are all-or-none. The bucket name reuses ``R2_BUCKET`` so
 * analytics can never be pointed at a request-controlled or divergent bucket.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   accountId: string,
 *   apiToken: string,
 *   bucket: string,
 *   billingCycleDay: number,
 * } | null}
 */
function parseCloudflareAnalyticsConfig(env) {
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const apiToken = String(
    env.CLOUDFLARE_ANALYTICS_API_TOKEN || "",
  ).trim();
  const billingCycleDay = parseBillingCycleDay(
    env.CLOUDFLARE_BILLING_CYCLE_DAY,
  );
  if (!accountId && !apiToken) return null;
  if (!accountId || !apiToken) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_API_TOKEN must be set together",
    );
  }
  const bucket = String(env.R2_BUCKET || "").trim();
  if (!bucket) {
    throw new Error(
      "Cloudflare analytics requires the existing R2_BUCKET setting",
    );
  }
  return { accountId, apiToken, bucket, billingCycleDay };
}

/**
 * Optional, read-only Atlas Admin API service account. The five settings are
 * all-or-none so a production deploy cannot silently report partial Atlas
 * health or accidentally query a different project/cluster.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   clientId: string,
 *   clientSecret: string,
 *   orgId: string,
 *   projectId: string,
 *   clusterName: string,
 *   secretExpiresAt: string|null,
 * } | null}
 */
function parseAtlasAdminConfig(env) {
  const fields = {
    clientId: String(env.ATLAS_SERVICE_ACCOUNT_ID || "").trim(),
    clientSecret: String(env.ATLAS_SERVICE_ACCOUNT_SECRET || "").trim(),
    orgId: String(env.ATLAS_ORG_ID || "").trim(),
    projectId: String(env.ATLAS_PROJECT_ID || "").trim(),
    clusterName: String(env.ATLAS_CLUSTER_NAME || "").trim(),
  };
  const populated = Object.values(fields).filter(Boolean).length;
  const secretExpiresAtRaw = String(
    env.ATLAS_SERVICE_ACCOUNT_SECRET_EXPIRES_AT || "",
  ).trim();
  if (populated === 0 && !secretExpiresAtRaw) return null;
  if (populated !== Object.keys(fields).length) {
    throw new Error(
      "ATLAS_SERVICE_ACCOUNT_ID, ATLAS_SERVICE_ACCOUNT_SECRET, "
      + "ATLAS_ORG_ID, ATLAS_PROJECT_ID, and ATLAS_CLUSTER_NAME must be set together",
    );
  }
  let secretExpiresAt = null;
  if (secretExpiresAtRaw) {
    const expires = new Date(secretExpiresAtRaw);
    if (Number.isNaN(expires.getTime())) {
      throw new Error(
        "ATLAS_SERVICE_ACCOUNT_SECRET_EXPIRES_AT must be an ISO 8601 timestamp",
      );
    }
    secretExpiresAt = expires.toISOString();
  }
  return { ...fields, secretExpiresAt };
}

/**
 * Optional Render API capacity diagnostics. Render API keys are broadly
 * account-scoped rather than least-privilege credentials, so this integration
 * is opt-in and the adapter only performs service/metric GET requests. Render
 * injects RENDER_SERVICE_ID into a running service; only the API key normally
 * needs to be copied into the dashboard.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   apiKey: string,
 *   serviceId: string,
 *   monthlyCostUsd: number|null,
 * } | null}
 */
function parseRenderAdminConfig(env) {
  const apiKey = String(env.RENDER_API_KEY || "").trim();
  const serviceId = String(env.RENDER_SERVICE_ID || "").trim();
  const monthlyRaw = String(env.RENDER_MONTHLY_COST_USD || "").trim();
  // Render injects RENDER_SERVICE_ID automatically into every service. Its
  // presence alone must not turn this optional integration on or break an
  // existing production boot.
  if (!apiKey && !monthlyRaw) return null;
  if (!apiKey || !serviceId) {
    throw new Error(
      "RENDER_API_KEY and RENDER_SERVICE_ID must be set together",
    );
  }
  const monthlyCostUsd = monthlyRaw
    ? parseUsd(monthlyRaw, "RENDER_MONTHLY_COST_USD")
    : null;
  return { apiKey, serviceId, monthlyCostUsd };
}

/** @param {string|undefined} raw */
function parseBillingCycleDay(raw) {
  if (raw === undefined || raw === null || raw === "") return 1;
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    throw new Error("CLOUDFLARE_BILLING_CYCLE_DAY must be an integer from 1 to 28");
  }
  const day = Number.parseInt(value, 10);
  if (day < 1 || day > 28) {
    throw new Error("CLOUDFLARE_BILLING_CYCLE_DAY must be an integer from 1 to 28");
  }
  return day;
}

/** @param {string|undefined} raw @returns {'disabled'|'r2'} */
function parseReplayFilesStore(raw) {
  const value = String(raw || "disabled").trim().toLowerCase();
  if (!VALID_REPLAY_FILES_STORES.has(value)) {
    throw new Error(
      `REPLAY_FILES_STORE must be one of [disabled, r2]; got: ${raw}`,
    );
  }
  return /** @type {'disabled'|'r2'} */ (value);
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

/**
 * @param {string|undefined} raw
 * @param {number} fallback
 * @param {string} name
 * @returns {number}
 */
function parsePositiveInteger(raw, fallback, name) {
  const value = parseInteger(raw, fallback);
  if (value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** @param {string} raw @param {string} name */
function parseUsd(raw, name) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error(`${name} must be a non-negative USD amount`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value > 1_000_000) {
    throw new Error(`${name} must be a non-negative USD amount`);
  }
  return value;
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
  parseReplayFilesStore,
  parseR2Config,
  parseCloudflareAnalyticsConfig,
  parseAtlasAdminConfig,
  parseRenderAdminConfig,
  parseAnalyticsConfig,
  parsePlatformIntegrationsConfig,
};
