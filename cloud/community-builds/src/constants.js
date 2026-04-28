"use strict";

/**
 * Centralised constants. No magic numbers may appear elsewhere.
 *
 * Example:
 *   const { LIMITS, RACES } = require("./constants");
 *   if (build.signature.length > LIMITS.SIGNATURE_MAX_ITEMS) { ... }
 */

const RACES = Object.freeze(["Protoss", "Terran", "Zerg"]);
const VS_RACES = Object.freeze([...RACES, "Random"]);
const TIERS = Object.freeze(["S", "A", "B", "C"]);

const ID_REGEX = /^[a-z0-9-]{3,80}$/;

const KIBIBYTE = 1024;
const REQUEST_BODY_KIB = 64;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_SECOND = 1000;
const HOUR_IN_MS = SECONDS_PER_MINUTE * MINUTES_PER_HOUR * MS_PER_SECOND;

const LIMITS = Object.freeze({
  ID_MIN: 3,
  ID_MAX: 80,
  NAME_MIN: 3,
  NAME_MAX: 120,
  DESCRIPTION_MAX: 4000,
  STRING_LIST_ITEM_MAX: 200,
  STRING_LIST_MAX_ITEMS: 20,
  SIGNATURE_MIN_ITEMS: 4,
  SIGNATURE_MAX_ITEMS: 30,
  SIGNATURE_T_MIN: 0,
  SIGNATURE_T_MAX: 3600,
  SIGNATURE_WHAT_MAX: 200,
  WEIGHT_MIN: 0,
  WEIGHT_MAX: 1,
  TOLERANCE_MIN: 5,
  TOLERANCE_MAX: 60,
  MIN_MATCH_MIN: 0.3,
  MIN_MATCH_MAX: 1.0,
  PAGE_SIZE_DEFAULT: 50,
  PAGE_SIZE_MAX: 100,
  FLAG_HIDE_THRESHOLD: 5,
  REQUEST_BODY_BYTES: REQUEST_BODY_KIB * KIBIBYTE,
});

const RATE = Object.freeze({
  WRITE_PER_HOUR_PER_CLIENT: 30,
  READ_PER_HOUR_PER_IP: 1000,
  WINDOW_MS: HOUR_IN_MS,
});

const HTTP_TIMEOUT_MS = Object.freeze({
  CONNECT: 5000,
  READ: 30000,
});

const HEADER = Object.freeze({
  CLIENT_ID: "x-client-id",
  CLIENT_SIG: "x-client-signature",
  REQUEST_ID: "x-request-id",
});

const SORT_OPTIONS = Object.freeze(["votes", "recent"]);

const DEFAULTS = Object.freeze({
  TOLERANCE_SEC: 15,
  MIN_MATCH_SCORE: 0.6,
  TIER: null,
  PORT: 8080,
  LOG_LEVEL: "info",
  DB_NAME: "sc2_community_builds",
});

const COLLECTIONS = Object.freeze({
  BUILDS: "community_builds",
  VOTES: "build_votes",
  FLAGS: "build_flags",
});

const SERVICE = Object.freeze({
  NAME: "sc2-community-builds",
  VERSION: "1.0.0",
  ROUTE_PREFIX: "/v1/community-builds",
});

module.exports = {
  RACES,
  VS_RACES,
  TIERS,
  ID_REGEX,
  LIMITS,
  RATE,
  HTTP_TIMEOUT_MS,
  HEADER,
  SORT_OPTIONS,
  DEFAULTS,
  COLLECTIONS,
  SERVICE,
};
