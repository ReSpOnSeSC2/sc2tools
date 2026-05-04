// Service interfaces consumed by route handlers. Pure type-only
// declarations — no runtime exports.

export interface UsersService {
  ensureFromClerk(clerkUserId: string): Promise<{ userId: string }>;
  touch(userId: string): Promise<void>;
}

export interface OpponentsService {
  list(
    userId: string,
    opts?: { limit?: number; before?: Date },
  ): Promise<{ items: object[]; nextBefore: Date | null }>;
  get(userId: string, pulseId: string): Promise<object | null>;
  recordGame(
    userId: string,
    game: {
      pulseId: string;
      displayName: string;
      race: string;
      mmr?: number;
      leagueId?: number;
      result: "Victory" | "Defeat" | "Tie";
      opening?: string;
      playedAt: Date;
    },
  ): Promise<void>;
}

export interface GamesService {
  list(
    userId: string,
    opts?: { limit?: number; before?: Date; oppPulseId?: string },
  ): Promise<{ items: object[]; nextBefore: Date | null }>;
  get(userId: string, gameId: string): Promise<object | null>;
  upsert(userId: string, game: object & { gameId: string }): Promise<boolean>;
  stats(userId: string): Promise<{ total: number; latest: Date | null }>;
}

export interface CustomBuildsService {
  list(userId: string): Promise<object[]>;
  get(userId: string, slug: string): Promise<object | null>;
  upsert(userId: string, build: object & { slug: string }): Promise<void>;
  softDelete(userId: string, slug: string): Promise<void>;
}

export interface DevicePairingsService {
  start(): Promise<{ code: string; expiresAt: Date }>;
  claim(userId: string, code: string): Promise<void>;
  poll(
    code: string,
  ): Promise<
    | { status: "pending" }
    | { status: "expired" }
    | { status: "ready"; deviceToken: string; userId: string }
  >;
  findTokenByHash(hash: string): Promise<{ userId: string } | null>;
  listDevices(userId: string): Promise<object[]>;
  revoke(userId: string, tokenHash: string): Promise<void>;
}

export interface OverlayTokensService {
  create(userId: string, label: string): Promise<object>;
  list(userId: string): Promise<object[]>;
  resolve(token: string): Promise<{ userId: string; label: string } | null>;
  revoke(userId: string, token: string): Promise<void>;
}

export interface AggregationsService {
  summary(userId: string, filters: object): Promise<object>;
  matchups(userId: string, filters: object): Promise<object>;
  maps(userId: string, filters: object): Promise<object>;
  buildVsStrategy(userId: string, filters: object): Promise<object>;
  randomSummary(userId: string, filters: object): Promise<object>;
  timeseries(
    userId: string,
    opts: { interval?: "day" | "week" | "month" },
    filters: object,
  ): Promise<object>;
  gamesList(
    userId: string,
    filters: object,
    opts?: {
      search?: string;
      sort?: string;
      limit?: number;
      offset?: number;
      resultBucket?: "win" | "loss";
    },
  ): Promise<object>;
}

export interface BuildsService {
  list(userId: string, filters: object): Promise<object[]>;
  detail(
    userId: string,
    name: string,
    filters: object,
  ): Promise<object | null>;
  oppStrategies(userId: string, filters: object): Promise<object[]>;
}

export interface PerGameComputeService {
  buildOrder(userId: string, gameId: string): Promise<object | null>;
  macroBreakdown(userId: string, gameId: string): Promise<object | null>;
  apmCurve(userId: string, gameId: string): Promise<object | null>;
  writeMacroBreakdown(
    userId: string,
    gameId: string,
    payload: { macroScore: number; top3Leaks?: object[]; breakdown: object },
  ): Promise<void>;
  writeApmCurve(userId: string, gameId: string, curve: object): Promise<void>;
  writeOpponentBuildOrder(
    userId: string,
    gameId: string,
    payload: { oppBuildLog: string[]; oppEarlyBuildLog?: string[] },
  ): Promise<void>;
}

export interface MacroBackfillService {
  start(
    userId: string,
    opts?: { limit?: number; force?: boolean },
  ): Promise<{ jobId: string; total: number; status: string }>;
  reportProgress(
    userId: string,
    jobId: string,
    payload: { gameId: string; ok: boolean; message?: string },
  ): Promise<void>;
  status(userId: string, jobId: string): Promise<object | null>;
  latest(userId: string): Promise<object[]>;
}

export interface ImportService {
  scan(
    userId: string,
    body: { folder?: string; since_iso?: string; until_iso?: string },
  ): Promise<{ jobId: string; status: string }>;
  start(
    userId: string,
    body: {
      folder: string;
      workers?: number;
      since_iso?: string;
      until_iso?: string;
      force?: boolean;
    },
  ): Promise<{ jobId: string; status: string; workers: number }>;
  cancel(userId: string): Promise<{ ok: boolean; cancelled: number; jobId?: string }>;
  status(userId: string): Promise<object>;
  list(userId: string): Promise<object>;
  reportProgress(
    userId: string,
    jobId: string,
    payload: object,
  ): Promise<object>;
  cores(userId: string): Promise<object>;
  setHostInfo(
    userId: string,
    payload: { cores?: number; replayFolders?: string[] },
  ): Promise<object>;
  extractIdentities(userId: string, body: { folder?: string }): Promise<object>;
  pickFolder(userId: string): Promise<object>;
}

export interface SpatialService {
  maps(userId: string, filters: object): Promise<object[]>;
  buildings(
    userId: string,
    map: string,
    filters: object,
    opts?: { grid?: number },
  ): Promise<object>;
  proxy(
    userId: string,
    map: string,
    filters: object,
    opts?: { grid?: number },
  ): Promise<object>;
  battle(
    userId: string,
    map: string,
    filters: object,
    opts?: { grid?: number },
  ): Promise<object>;
  deathZone(
    userId: string,
    map: string,
    filters: object,
    opts?: { grid?: number },
  ): Promise<object>;
  opponentProxies(
    userId: string,
    map: string,
    filters: object,
    opts?: { grid?: number },
  ): Promise<object>;
}

export interface CatalogService {
  catalog(): Promise<object>;
  catalogLookup(): { lookup: (rawName: string) => object | null };
  definitions(): Promise<object>;
  exportCsv(userId: string, filters: object): AsyncGenerator<string, void, void>;
  mapImagePath(name: string): { path: string; contentType: string } | null;
  playbackInfo(): object;
}

export interface MLService {
  status(userId: string): Promise<object>;
  train(
    userId: string,
    opts?: { kind?: string },
  ): Promise<{ jobId: string; status: string }>;
  predict(userId: string, payload: object): Promise<object>;
  pregame(userId: string, payload: object): Promise<object>;
  options(userId: string): Promise<object>;
}

export interface AgentVersionService {
  latest(opts?: { channel?: string; platform?: string }): Promise<object | null>;
  publish(payload: object): Promise<{ channel: string; version: string }>;
  history(opts?: { channel?: string }): Promise<object[]>;
}
