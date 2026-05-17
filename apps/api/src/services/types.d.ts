// Service interfaces consumed by route handlers. Pure type-only
// declarations — no runtime exports.

export interface UserProfile {
  battleTag?: string;
  pulseId?: string;
  region?: string;
  preferredRace?: string;
  displayName?: string;
}

export interface UserSummary {
  userId: string;
  clerkUserId: string | null;
  email: string | null;
}

export interface UsersService {
  ensureFromClerk(clerkUserId: string): Promise<{ userId: string }>;
  touch(userId: string): Promise<void>;
  getProfile(userId: string): Promise<UserProfile>;
  updateProfile(
    userId: string,
    profile: { [K in keyof UserProfile]?: string | null },
  ): Promise<UserProfile>;
  getSummary(userId: string): Promise<UserSummary>;
  setEmail(userId: string, email: string): Promise<void>;
  upsertFromWebhook(clerkUserId: string, email: string | null): Promise<boolean>;
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
      toonHandle?: string;
      pulseCharacterId?: string;
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
  todaySession(
    userId: string,
    timezone?: string,
  ): Promise<{
    wins: number;
    losses: number;
    games: number;
    mmrStart?: number;
    mmrCurrent?: number;
    region?: string;
    sessionStartedAt?: string;
    streak?: { kind: "win" | "loss"; count: number };
  }>;
}

/**
 * Per-phase row shape returned by ``buildCompositions.computeCompositions``.
 * Mirrors the runtime contract so ``serverApi.ts`` on the web app can
 * type the /v1/custom-builds/:slug/compositions response without
 * duplicating the field list.
 */
export interface BuildPhaseRow {
  signatures: Array<{
    key: string;
    units: Array<{ token: string; count: number }>;
    sampleCount: number;
    wins: number;
    losses: number;
    winRate: number;
    sampleGameIds: string[];
  }>;
  tech: Array<{
    token: string;
    sampleCount: number;
    medianFirstSeen: number;
    p25: number;
    p75: number;
  }>;
  upgrades: Array<{
    token: string;
    sampleCount: number;
    medianFirstSeen: number;
    p25: number;
    p75: number;
  }>;
}

/**
 * Phase-aware compositions payload for the scouting widget. Keys on
 * ``perPhase`` are ``"early" | "earlyMid" | "mid" | "midLate" | "late"``;
 * record-shape used here so the consumer can iterate without a fixed
 * union literal (server may add phases in future revisions of the
 * classifier).
 */
export interface BuildPhasePayload {
  slug: string;
  name: string;
  sampleSize: Record<string, number>;
  perPhase: Record<string, BuildPhaseRow>;
  finalPhaseDistribution: Record<string, number>;
  flags: string[];
}

/**
 * Sankey-shaped transitions payload for the BuildDetail transitions
 * tab. The ``transitions`` half of the unified bundle, split out so
 * the route can be requested independently of the heavier compositions
 * one.
 */
export interface BuildTransitionsPayload {
  slug: string;
  name: string;
  transitions: {
    nodes: Array<{
      id: string;
      label: string;
      column: 0 | 1 | 2 | 3;
      kind: "build" | "oppStrategy" | "finalPhase" | "lateComp";
      games: number;
      wins: number;
      losses: number;
      iconTokens?: string[];
    }>;
    edges: Array<{
      from: string;
      to: string;
      games: number;
      wins: number;
      losses: number;
      winRate: number;
    }>;
    rare: { collapsedNodes: number; collapsedEdges: number };
  };
}

export interface CustomBuildsService {
  list(userId: string): Promise<object[]>;
  get(userId: string, slug: string): Promise<object | null>;
  upsert(userId: string, build: object & { slug: string }): Promise<void>;
  softDelete(userId: string, slug: string): Promise<void>;
  evaluateBuild(userId: string, slug: string): Promise<object | null>;
  evaluateBuildPhases(
    userId: string,
    slug: string,
    opts?: { includeTransitions?: boolean },
  ): Promise<
    | null
    | (BuildPhasePayload & { transitions?: BuildTransitionsPayload["transitions"] })
  >;
  evaluateAllStats(userId: string): Promise<object[]>;
  latestGameDateMs(userId: string): Promise<number>;
  reclassify(
    userId: string,
    slug: string,
    opts?: { replace?: boolean },
  ): Promise<{
    slug: string;
    name: string;
    scanned: number;
    matched: number;
    tagged: number;
    cleared: number;
    ruleCount: number;
  } | null>;
  reclassifyAll(
    userId: string,
    opts?: { clearUnmatched?: boolean },
  ): Promise<{
    builds: number;
    scanned: number;
    tagged: number;
    cleared: number;
    perBuild: Array<{ slug: string; name: string; matched: number; tagged: number }>;
  }>;
  tagSingleGame(
    userId: string,
    game: {
      gameId?: string;
      myRace?: string | null;
      myBuild?: string | null;
      buildLog?: string[];
      oppBuildLog?: string[];
      opponent?: { race?: string | null } | null;
    },
  ): Promise<
    | null
    | { gameId: string; matched: number; chosen: string | null; ruleCount: number }
  >;
}

export interface ParsedBuildLogEvent {
  time: number;
  name: string;
  race?: string;
  category?: string;
  is_building?: boolean;
}

export interface PerGameComputeServiceListedGame {
  gameId: string;
  myBuild: string | null;
  myRace: string | null;
  oppRace: string | null;
  events: ParsedBuildLogEvent[];
  oppEvents: ParsedBuildLogEvent[];
  result: string | null;
  date: Date | null;
  map: string | null;
  /** Present only when `listForRulePreview` is called with
   *  `{ includeMacroBreakdown: true }`. The buildCompositions
   *  service is the primary consumer; rule preview / reclassify
   *  paths never request it. */
  macroBreakdown?: object | null;
}

export interface DeviceListItem {
  deviceId: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  hostname?: string;
  agentVersion?: string;
  agentOs?: string;
  agentOsRelease?: string;
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
  listDevices(userId: string): Promise<DeviceListItem[]>;
  latestAgent(userId: string): Promise<{ paired: boolean; version: string | null }>;
  revoke(userId: string, tokenHash: string): Promise<void>;
  revokeById(userId: string, deviceId: string): Promise<boolean>;
  recordHeartbeat(
    userId: string,
    tokenHash: string,
    body: {
      version?: string;
      os?: string;
      osRelease?: string;
      hostname?: string;
    },
  ): Promise<{ receivedAt: Date }>;
}

export interface OverlayTokensService {
  create(userId: string, label: string): Promise<object>;
  list(userId: string): Promise<
    Array<{
      token: string;
      label: string;
      createdAt: Date;
      lastSeenAt?: Date | null;
      revokedAt?: Date | null;
      enabledWidgets: string[];
    }>
  >;
  resolve(token: string): Promise<
    | {
        userId: string;
        label: string;
        enabledWidgets: string[];
      }
    | null
  >;
  revoke(userId: string, token: string): Promise<void>;
  setWidgetEnabled(
    userId: string,
    token: string,
    widget: string,
    enabled: boolean,
  ): Promise<{ enabledWidgets: string[] }>;
  tokenBelongsToUser(userId: string, token: string): Promise<boolean>;
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

export interface StreakService {
  current(
    userId: string,
    filters?: object,
  ): Promise<{
    kind: "win" | "loss" | null;
    count: number;
    lastGameAt: string | null;
  }>;
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
  listForRulePreview(
    userId: string,
    opts?: { limit?: number; includeMacroBreakdown?: boolean },
  ): Promise<PerGameComputeServiceListedGame[]>;
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
