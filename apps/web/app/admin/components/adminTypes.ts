/**
 * Wire-shape types for the admin endpoints. Mirrors the response
 * payloads served by ``services/admin.js`` + ``routes/admin.js``.
 *
 * Kept as a single file so all admin tab modules can import from
 * one place; a change to the API response shape lights up every
 * call site at the type-checker level.
 */

export type StorageStatsResp = {
  totalDocs: number;
  totalDataBytes: number;
  totalStorageBytes: number;
  totalIndexBytes: number;
  collections: Array<{
    name: string;
    count: number;
    avgObjSize: number;
    storageSize: number;
    totalSize: number;
    indexSize: number;
  }>;
};

export type UserListFilter = "all" | "with_games" | "no_games" | "with_agent";

export type AdminUserRow = {
  userId: string;
  clerkUserId: string | null;
  email: string | null;
  gameCount: number;
  opponentCount: number;
  lastActivity: string | null;
  firstActivity: string | null;
  hasAgent: boolean;
  agentLastSeenAt: string | null;
  storageEstimateBytes: number;
};

export type UsersListResp = {
  items: AdminUserRow[];
  nextBefore: string | null;
};

export type AdminUserDetail = {
  userId: string;
  clerkUserId: string | null;
  email: string | null;
  createdAt: string | null;
  lastSeenAt: string | null;
  games: {
    total: number;
    wins: number;
    losses: number;
    firstActivity: string | null;
    lastActivity: string | null;
  };
  opponents: {
    total: number;
    top: Array<{
      pulseId: string;
      displayNameSample: string;
      race: string;
      gameCount: number;
      wins: number;
      losses: number;
    }>;
  };
};

export type AdminOpponentRow = {
  pulseId: string;
  displayNameSample: string;
  race: string;
  gameCount: number;
  wins: number;
  losses: number;
  /** Fraction in [0, 1] — wins / gameCount, computed server-side. */
  winRate: number;
  firstSeen: string | null;
  lastSeen: string | null;
  mmr: number | null;
  leagueId: number | null;
};

export type OpponentSort =
  | "gameCount"
  | "wins"
  | "losses"
  | "winRate"
  | "lastSeen"
  | "firstSeen"
  | "mmr";

export type OpponentsListResp = {
  items: AdminOpponentRow[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  /** Distinct races present across all of the user's opponents. */
  races: string[];
};

export type AdminGameVsOpponentRow = {
  gameId: string;
  date: string | null;
  result: string | null;
  myRace: string | null;
  map: string | null;
  durationSec: number | null;
  myMmr: number | null;
  macroScore: number | null;
  opponent: {
    displayName: string;
    race: string;
    mmr: number | null;
  };
};

export type OpponentGamesResp = {
  items: AdminGameVsOpponentRow[];
  nextBefore: string | null;
};

export type RebuildResp = {
  userId: string;
  droppedRows: number;
  // Returned alongside the rebuild after May-2026 — the admin
  // tool now chains a SC2Pulse character-id backfill so the
  // operator both rebuilds counters AND heals stuck-on-TOON
  // opponent rows in a single click. Null when the cron is
  // disabled or no rows needed healing; otherwise carries the
  // counters the SPA renders next to "dropped N rows".
  pulseBackfill?: {
    scanned: number;
    resolved: number;
    updated: number;
    skipped: number;
  } | null;
};

export type WipeResp = {
  games: number;
  opponents: number;
  macroJobs: number;
  range: { since: string | null; until: string | null };
};

export type HealthResp = {
  mongo: {
    ok: boolean;
    latencyMs: number | null;
    error: string | null;
  };
  uptime: {
    startedAt: string;
    uptimeSeconds: number;
  };
  runtime: {
    nodeVersion: string;
    gameDetailsStore: string;
  };
};

// ---- Global tracking (/admin/global) ----------------------------------

export type GlobalSummaryResp = {
  /** Distinct real players tracked across every user (merged by toon). */
  trackedPlayers: number;
  /** Raw per-user opponent rows (before the cross-user merge). */
  opponentRows: number;
  /** Distinct users who track at least one opponent. */
  usersTracking: number;
  totalGames: number;
  /** Shared SC2Pulse cache coverage. */
  cache: {
    total: number;
    resolved: number;
    mmrCached: number;
  };
  generatedAt: string;
};

export type GlobalPlayerRow = {
  pulseId: string;
  pulseCharacterId: string | null;
  displayNameSample: string;
  race: string;
  gameCount: number;
  wins: number;
  losses: number;
  /** Fraction in [0, 1], computed server-side. */
  winRate: number;
  /** How many distinct platform users track this player. */
  trackedByUsers: number;
  mmr: number | null;
  leagueId: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
};

export type GlobalPlayerSort =
  | "gameCount"
  | "wins"
  | "losses"
  | "winRate"
  | "trackedByUsers"
  | "lastSeen"
  | "firstSeen"
  | "mmr";

export type GlobalPlayersResp = {
  items: GlobalPlayerRow[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  races: string[];
};

export type GlobalBreakdownRow = {
  key: string;
  count: number;
  wins: number;
  /** Fraction in [0, 1] from the uploader's perspective. */
  winRate: number;
};

export type GlobalBreakdownsResp = {
  strategies: GlobalBreakdownRow[];
  builds: GlobalBreakdownRow[];
  maps: GlobalBreakdownRow[];
  generatedAt: string;
};

export type AdminEventType = "user_signup" | "agent_download" | "user_message";

export type AdminEventSignupPayload = {
  clerkUserId: string;
  userId: string | null;
  email: string | null;
  source: string;
};

export type AdminEventUserMessagePayload = {
  userId: string | null;
  clerkUserId: string | null;
  email: string | null;
  subject: string;
  message: string;
};

export type AdminEventDownloadPayload = {
  platform: "windows" | "macos" | "linux" | "unknown";
  version: string | null;
  channel: string;
  ip: string | null;
  userAgent: string | null;
  referer: string | null;
  country: string | null;
};

export type AdminEvent = {
  eventId: string;
  type: AdminEventType;
  payload:
    | AdminEventSignupPayload
    | AdminEventDownloadPayload
    | AdminEventUserMessagePayload;
  createdAt: string;
  readAt: string | null;
};

export type AdminEventsListResp = {
  items: AdminEvent[];
  nextBefore: string | null;
};

export type AdminEventCountsResp = {
  totalUsers: number;
  signupsToday: number;
  signupsThisWeek: number;
  totalSignupsTracked: number;
  totalDownloads: number;
  downloadsToday: number;
  downloadsThisWeek: number;
  downloadsByPlatform: {
    windows: number;
    macos: number;
    linux: number;
  };
  unreadCount: number;
  /** Connected-agent counters from the deviceTokens collection. */
  agents: {
    total: number;
    active24h: number;
    active7d: number;
  };
  generatedAt: string;
};
