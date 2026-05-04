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
});

const LIMITS = Object.freeze({
  REQUEST_BODY_BYTES: 5 * 1024 * 1024,
  GAMES_PAGE_SIZE: 100,
  OPPONENTS_PAGE_SIZE: 100,
  PAIRING_CODE_TTL_SEC: 600,
  PAIRING_CODE_LEN: 6,
});

const TIMEOUTS = Object.freeze({
  MONGO_CONNECT_MS: 5000,
  MONGO_SOCKET_MS: 30000,
});

module.exports = { DEFAULTS, SERVICE, COLLECTIONS, LIMITS, TIMEOUTS };
