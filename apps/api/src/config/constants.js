"use strict";

/**
 * App-wide constants. Magic numbers/strings live here, never inline.
 */

const DEFAULTS = Object.freeze({
  PORT: 8080,
  LOG_LEVEL: "info",
  DB_NAME: "sc2tools_saas",
  RATE_LIMIT_PER_MINUTE: 120,
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
});

const LIMITS = Object.freeze({
  REQUEST_BODY_BYTES: 5 * 1024 * 1024,
  GAMES_PAGE_SIZE: 100,
  GAMES_LIST_MAX: 10000,
  GAMES_LIST_DEFAULT: 2000,
  OPPONENTS_PAGE_SIZE: 100,
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
