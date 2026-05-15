"use strict";

/**
 * App-wide constants. Magic numbers/strings live here, never inline.
 */

const DEFAULTS = Object.freeze({
  PORT: 8080,
  LOG_LEVEL: "info",
  DB_NAME: "sc2tools_saas",
  RATE_LIMIT_PER_MINUTE: 120,
  // Keep-alive heartbeat for Render's "starter" idle timeout (15min). 13min
  // gives a healthy safety margin and stays just below typical CDN cache
  // windows so the upstream actually sees the request.
  KEEPALIVE_INTERVAL_MS: 13 * 60 * 1000,
});

const SERVICE = Object.freeze({
  NAME: "sc2tools-api",
  ROUTE_PREFIX: "/v1",
});

const COLLECTIONS = Object.freeze({
  USERS: "users",
  PROFILES: "profiles",
  OPPONENTS: "opponents",
  GAMES: "games",
  // Per-game heavy fields (build logs, macroBreakdown, apmCurve,
  // spatial). Split out of ``games`` in v0.4.3 so list-page queries
  // can scan slim metadata without dragging ~40 kB of detail data
  // into RAM per game. Keyed on the same ``{userId, gameId}`` tuple
  // as games. See ``services/gameDetails.js``.
  GAME_DETAILS: "game_details",
  CUSTOM_BUILDS: "custom_builds",
  DEVICE_PAIRINGS: "device_pairings",
  DEVICE_TOKENS: "device_tokens",
  OVERLAY_TOKENS: "overlay_tokens",
  ML_MODELS: "ml_models",
  ML_JOBS: "ml_jobs",
  IMPORT_JOBS: "import_jobs",
  MACRO_JOBS: "macro_jobs",
  AGENT_RELEASES: "agent_releases",
  COMMUNITY_BUILDS: "community_builds",
  COMMUNITY_REPORTS: "community_reports",
  USER_BACKUPS: "user_backups",
  ARCADE_LEADERBOARD: "arcade_leaderboard",
  // Pre-aggregated snapshot cohorts (build × matchup × MMR × scope).
  // Cached aggregations of per-tick percentile bands (winner / loser
  // ribbons) so the snapshot drilldown page never has to scan the
  // games + gameDetails join on every request. Keyed by a SHA-256
  // hash of (cohortKey + mmrBucket + scope); TTL'd via expiresAt so a
  // stale cohort eventually gets recomputed without manual eviction.
  // See ``services/snapshotCache.js`` for the read/write API and
  // ``scripts/precomputeSnapshotCohorts.js`` for the nightly warmer.
  SNAPSHOT_COHORTS: "snapshot_cohorts",
  // Per-(matchup, mmrBucket, tick) composition matchup matrix cache.
  // Cluster assignments + K×K win-rate grid + counter-suggestion seed
  // data. Keyed by hash(matchup + mmrBucket + scope + tick + inputIds).
  // The matrix payload is heavier than a per-cohort bands row (it
  // carries centroids and the full grid) — kept in its own collection
  // so a TTL eviction of one doesn't drag the other into a recompute.
  SNAPSHOT_MATRICES: "snapshot_matrices",
});

const LIMITS = Object.freeze({
  REQUEST_BODY_BYTES: 5 * 1024 * 1024,
  GAMES_PAGE_SIZE: 100,
  GAMES_LIST_MAX: 20000,
  GAMES_LIST_DEFAULT: 2000,
  OPPONENTS_PAGE_SIZE: 100,
  // The analyzer SPA can request up to this many opponents in one
  // call so users with thousands of replays don't have to flip
  // through pages just to see the full table. Cursor pagination
  // (`before`) still works above this; this is a per-request ceiling.
  OPPONENTS_LIST_MAX: 5000,
  PAIRING_CODE_TTL_SEC: 600,
  PAIRING_CODE_LEN: 6,
  CSV_EXPORT_MAX_ROWS: 50000,
  TIMESERIES_MAX_BUCKETS: 365,
  ML_TRAINING_MAX_GAMES: 50000,
  IMPORT_JOB_HISTORY: 50,
  MACRO_JOB_HISTORY: 50,
});

const TIMEOUTS = Object.freeze({
  MONGO_CONNECT_MS: 5000,
  MONGO_SOCKET_MS: 30000,
  PYTHON_SPAWN_MS: 5 * 60 * 1000,
  PYTHON_LONG_SPAWN_MS: 30 * 60 * 1000,
});

const PYTHON = Object.freeze({
  ANALYZER_DIR_ENV: "SC2_PY_ANALYZER_DIR",
  PYTHON_EXE_ENV: "SC2_PY_PYTHON",
  DEFAULT_DIR: "/opt/sc2-analyzer",
  DEFAULT_EXE: "python3",
});

module.exports = {
  DEFAULTS,
  SERVICE,
  COLLECTIONS,
  LIMITS,
  TIMEOUTS,
  PYTHON,
};
