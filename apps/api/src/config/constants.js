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
  // Per-process replay-ingest admission. One active batch is conservative on
  // Render Starter: excess requests receive a retryable 503 before their
  // multi-megabyte JSON bodies are parsed.
  REPLAY_INGEST_MAX_ACTIVE: 1,
  // Games per user per UTC day accepted from in-browser (Clerk-session)
  // ingest. Far above a real history import (~a few thousand replays), low
  // enough that a scripted browser session cannot flood the single ingest
  // lane indefinitely. Device-token (desktop agent) uploads are never capped.
  BROWSER_INGEST_DAILY_CAP: 5000,
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
  // User-authored scouting notes live separately from the derived
  // opponents aggregate. Admin rebuilds can safely drop/recreate the
  // aggregate without erasing notes the user wrote by hand.
  OPPONENT_NOTES: "opponent_notes",
  GAMES: "games",
  // Per-game heavy fields (build logs, macroBreakdown, apmCurve,
  // spatial). Split out of ``games`` in v0.4.3 so list-page queries
  // can scan slim metadata without dragging ~40 kB of detail data
  // into RAM per game. Keyed on the same ``{userId, gameId}`` tuple
  // as games. See ``services/gameDetails.js``.
  GAME_DETAILS: "game_details",
  CUSTOM_BUILDS: "custom_builds",
  CUSTOM_BUILD_JOBS: "custom_build_jobs",
  DEVICE_PAIRINGS: "device_pairings",
  DEVICE_TOKENS: "device_tokens",
  OVERLAY_TOKENS: "overlay_tokens",
  MULTICHAT_STUDIO: "multichat_studio",
  MULTICHAT_SOUNDS: "multichat_sounds",
  MULTICHAT_ENGAGEMENT_EVENTS: "multichat_engagement_events",
  MULTICHAT_VIEWERS: "multichat_viewers",
  MULTICHAT_PREDICTIONS: "multichat_predictions",
  MULTICHAT_CLIP_MOMENTS: "multichat_clip_moments",
  // Official OAuth connections live outside generic user preferences so
  // encrypted refresh/access tokens can never leak to an overlay response.
  PLATFORM_CONNECTIONS: "platform_connections",
  PUBLIC_YOUTUBE_ARCHIVES: "public_youtube_archives",
  PLATFORM_OAUTH_STATES: "platform_oauth_states",
  PLATFORM_WEBHOOK_RECEIPTS: "platform_webhook_receipts",
  PLATFORM_EVENTS: "platform_events",
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
  SITE_PRESENCE: "site_presence",
  COACHING: "coaching_locker",
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
  PLAYER_CHANNELS: "player_channels",
  PLAYER_IDENTITIES: "player_identities",
  PLAYER_IDENTITY_SUBMISSIONS: "player_identity_submissions",
  PLAYER_IDENTITY_DIRECTORY: "player_identity_directory",
  // Replay Review Exchange. Requests freeze a redacted snapshot of one of
  // the asker's games; comments pin a moment (and optionally a map point)
  // on that game's timeline. Karma is an append-only ledger whose unique
  // (commentId, kind, actorId) key makes every reward idempotent; blocks
  // are per-user mutes. See docs/reviews.md.
  REVIEW_REQUESTS: "review_requests",
  REVIEW_COMMENTS: "review_comments",
  REVIEW_KARMA_EVENTS: "review_karma_events",
  REVIEW_BLOCKS: "review_blocks",
  // Per-user in-app notifications (the header bell). Distinct from the
  // admin-only ``admin_events`` feed above.
  NOTIFICATIONS: "notifications",
  // Per-user, per-UTC-day counter of games accepted from browser ingest.
  // Short-lived (TTL) rows; see ``services/browserIngestQuota.js``.
  BROWSER_INGEST_DAILY: "browser_ingest_daily",
  // SC2 Tools Guides. ``guide_samples``: one compact, pseudonymous row per
  // eligible ladder game (build-log milestone times + army snapshots),
  // keyed by HMACs of userId/gameId — see services/guideSamples.js.
  // ``guide_stats``: the nightly cross-user aggregate (services/guideStats.js).
  // ``guide_notes``: admin-authored coach's notes per build page.
  GUIDE_SAMPLES: "guide_samples",
  GUIDE_STATS: "guide_stats",
  GUIDE_NOTES: "guide_notes",
});

const LIMITS = Object.freeze({
  REQUEST_BODY_BYTES: 5 * 1024 * 1024,
  // Original .SC2Replay uploads use direct-to-R2 signed URLs, but the API
  // still validates the declared and completed object size against this
  // ceiling. Matches the established public replay-preview limit.
  REPLAY_FILE_MAX_BYTES: 5 * 1024 * 1024,
  GAMES_PAGE_SIZE: 100,
  // General replay history is a single JSON response. Keep it bounded even
  // when a stale client asks for the old 20k Arcade payload; complete-history
  // analysis now uses the cursor-paged route below.
  GAMES_LIST_MAX: 2000,
  GAMES_LIST_DEFAULT: 2000,
  // The filtered /games-list aggregation already projects compact display
  // rows and powers a 5,000-row strategy drill-down. Keep its established
  // ceiling independent from the full-document /games route above.
  // Compact filtered replay rows used by the Strategies drill-down. The
  // largest production consumer requests 5,000; do not let a crafted query
  // materialise four times that many rows in one Mongo facet/JSON response.
  GAMES_FILTERED_LIST_MAX: 5000,
  // Dashboard Daily Pulse + Arcade need a complete (up to 20k) history,
  // but no single API response should materialise that whole corpus.  The
  // dedicated analysis-corpus route cursor-pages this many narrowly
  // projected rows at a time.
  GAMES_ANALYSIS_PAGE_SIZE: 2000,
  GAMES_ANALYSIS_PAGE_MAX: 2000,
  GAMES_ANALYSIS_CORPUS_MAX: 20000,
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
  OPPONENT_NOTES_MAX_LENGTH: 500,
  PAIRING_CODE_TTL_SEC: 600,
  PAIRING_CODE_LEN: 6,
  CSV_EXPORT_MAX_ROWS: 50000,
  TIMESERIES_MAX_BUCKETS: 365,
  ML_TRAINING_MAX_GAMES: 50000,
  IMPORT_JOB_HISTORY: 50,
  MACRO_JOB_HISTORY: 50,
  // POST /v1/games/exists: ids per request. 500 ids x 200 ASCII chars is
  // ~100 kB, well inside the ordinary 256 kB JSON parser; real ids (date |
  // opponent | map | seconds) are far shorter even with non-Latin names.
  GAMES_EXISTS_MAX_IDS: 500,
  // Game ids are bounded to the same length everywhere they are accepted.
  GAME_ID_MAX_LENGTH: 200,
});

// Upload provenance stamped on slim game rows. ``ingestSource`` is derived
// server-side from the authenticated caller; ``engineVersion`` is the semver
// of the in-browser analysis engine (MAJOR.MINOR.PATCH with an optional
// pre-release and/or build suffix, e.g. 1.6.3-rc.1 or 1.6.3+build.5).
const INGEST_PROVENANCE = Object.freeze({
  SOURCES: Object.freeze(["agent", "browser"]),
  SOURCE_AGENT: "agent",
  SOURCE_BROWSER: "browser",
  ENGINE_VERSION_MAX_LENGTH: 40,
  ENGINE_VERSION_PATTERN:
    "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
});

// Replay Review Exchange (docs/reviews.md). Every threshold the feature
// enforces lives here so the playbook and the code cannot drift apart.
const REVIEWS = Object.freeze({
  QUESTION_MIN: 20,
  QUESTION_MAX: 500,
  COMMENT_MIN: 10,
  COMMENT_MAX: 2000,
  COMMENT_MAX_LINKS: 5,
  MAX_OPEN_REQUESTS: 3,
  MAX_NEW_REQUESTS_PER_DAY: 3,
  MAX_COMMENTS_PER_REQUEST: 500,
  COMMENTS_PER_HOUR: 30,
  COMMENTS_PER_DAY: 200,
  MIN_SYNCED_GAMES_TO_COMMENT: 20,
  EDIT_WINDOW_MS: 15 * 60 * 1000,
  MAX_RANGE_SEC: 300,
  AUTO_HIDE_DISTINCT_REPORTS: 3,
  KARMA_HELPFUL: 5,
  KARMA_BEST: 15,
  KARMA_UPVOTE: 1,
  KARMA_UPVOTE_CAP_PER_COMMENT: 10,
  KARMA_REMOVED: -20,
  // Verified reviewer band: ladder 1v1 games in the current or previous
  // season, per race. A band needs BAND_SUPPORT games at or above it and
  // the race needs MIN_GAMES in total, so one outlier never verifies.
  VERIFY_MIN_GAMES: 10,
  VERIFY_BAND_SUPPORT: 3,
  VERIFY_FALLBACK_WINDOW_DAYS: 180,
  VERIFY_TTL_MS: 12 * 60 * 60 * 1000,
  BOARD_PAGE_DEFAULT: 20,
  BOARD_PAGE_MAX: 40,
  LEADERBOARD_SIZE: 10,
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
  REVIEWS,
  TIMEOUTS,
  PYTHON,
  INGEST_PROVENANCE,
};
