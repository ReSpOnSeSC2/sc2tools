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

export type AdminUserRow = {
  userId: string;
  clerkUserId: string | null;
  gameCount: number;
  opponentCount: number;
  lastActivity: string | null;
  firstActivity: string | null;
  storageEstimateBytes: number;
};

export type UsersListResp = {
  items: AdminUserRow[];
  nextBefore: string | null;
};

export type AdminUserDetail = {
  userId: string;
  clerkUserId: string | null;
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

export type RebuildResp = {
  userId: string;
  droppedRows: number;
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
