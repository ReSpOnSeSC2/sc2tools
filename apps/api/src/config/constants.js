"use strict";

/**
 * App-wide constants. Magic numbers/strings live here, never inline.
 */

const DEFAULTS = Object.freeze({
  PORT: 8080,
  LOG_LEVEL: "info",
  DB_NAME: "sc2tools_saas",
  // 600 (was 120): agent initial-import bursts tripped 429s at 120/min,
  // which also shrank the agent's adaptive upload batch size. The agent's
  // Retry-After handling still bounds worst-case load.
  RATE_LIMIT_PER_MINUTE: 600,
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
  MULTICHAT_STUDIO: "multichat_studio",
  MULTICHAT_SOUNDS: "multichat_sounds",
  MULTICHAT_ENGAGEMENT_EVENTS: "multichat_engagement_events",
  MULTICHAT_VIEWERS: "multichat_viewers",
  MULTICHAT_PREDICTIONS: "multichat_predictions",
  MULTICHAT_CLIP_MOMENTS: "multichat_clip_moments",
  ML_MODELS: "ml_models",
  ML_JOBS: "ml_jobs",
  IMPORT_JOBS: "import_jobs",
  MACRO_JOBS: "macro_jobs",
  AGENT_RELEASES: "agent_releases",
  COMMUNITY_BUILDS: "community_builds",
  COMMUNITY_REPORTS: "community_reports",
  USER_BACKUPS: "user_backups",
  ARCADE_LEADERBOARD: "arcade_leaderboard",
  // Admin notification feed — one row per signup/download event.
  // Drives the /admin Dashboard counters + /admin/notifications feed.
  ADMIN_EVENTS: "admin_events",
  // Global, cross-user SC2Pulse cache. One row per real SC2 account
  // (keyed by toon handle), shared by every platform user so the
  // expensive toon→characterId resolution and the current MMR / per-
  // race breakdown are pulled from sc2pulse.nephest.com ONCE and then
  // served to everyone who later runs into that opponent. NOT keyed by
  // userId — the per-user ``opponents`` rows stay private and read
  // their public Pulse fields from here. See ``services/pulseDirectory.js``.
  PULSE_ACCOUNTS: "pulse_accounts",
  // Global, cross-user SC2Pulse character → account/pro linkage cache.
  // One row per SC2Pulse character id, recording which Battle.net
  // account (``accountId``) and community-verified player identity
  // (``proId`` / ``proNickname``) SC2Pulse has unified it under. The
  // Opponents tab's "group by player" view reads this to merge
  // multiple opponent rows that are the same human. NOT keyed by
  // userId — the linkage is public SC2Pulse data, fetched once and
  // shared by everyone. See ``services/pulseCharacterLinks.js``.
  PULSE_CHARACTER_LINKS: "pulse_character_links",
});

const LIMITS = Object.freeze({
  REQUEST_BODY_BYTES: 5 * 1024 * 1024,
  // Original .SC2Replay uploads use direct-to-R2 signed URLs, but the API
  // still validates the declared and completed object size against this
  // ceiling. Matches the established public replay-preview limit.
  REPLAY_FILE_MAX_BYTES: 5 * 1024 * 1024,
  GAMES_PAGE_SIZE: 100,
  GAMES_LIST_MAX: 20000,
  GAMES_LIST_DEFAULT: 2000,
  OPPONENTS_PAGE_SIZE: 100,
  // The analyzer SPA can request up to this many opponents in one
  // call so users with thousands of replays don't have to flip
  // through pages just to see the full table. Cursor pagination
  // (`before`) still works above this; this is a per-request ceiling.
  OPPONENTS_LIST_MAX: 5000,
  // Opponent replay history is deliberately paged instead of accumulated in
  // the browser. AllGamesTable renders both desktop and mobile row trees, so
  // keeping each page at 200 bounds both Mongo response size and DOM cost even
  // for accounts with tens of thousands of replays.
  OPPONENT_GAMES_PAGE_SIZE: 200,
  OPPONENT_GAMES_LIST_MAX: 200,
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
