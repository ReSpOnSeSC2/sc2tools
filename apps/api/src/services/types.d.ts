// Service interfaces consumed by route handlers. Pure type-only
// declarations — no runtime exports.

export interface UserProfile {
  battleTag?: string;
  pulseId?: string;
  // Canonical pulse-identity list; ``pulseId`` mirrors ``pulseIds[0]``
  // (see users.js getProfile / addPulseId).
  pulseIds?: string[];
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
  grantAdmin(
    targetUserId: string,
    grantedByClerkId: string,
  ): Promise<{ userId: string; clerkUserId: string } | null>;
  listDbAdminClerkIds(): Promise<string[]>;
  setBattleTags(userId: string, tags: string[]): Promise<UserProfile>;
  addPulseId(userId: string, pulseId: string): Promise<boolean>;
  getPreferences(userId: string, type: string): Promise<Record<string, unknown>>;
  updatePreferences(
    userId: string,
    type: string,
    prefs: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  patchLastKnownMmr(
    userId: string,
    update: { mmr: number; capturedAt?: string; region?: string },
  ): Promise<boolean>;
}

export interface OpponentsService {
  list(
    userId: string,
    opts?: { limit?: number; before?: Date; filters?: object },
  ): Promise<{ items: object[]; nextBefore: Date | null }>;
  get(
    userId: string,
    pulseId: string,
    opts?: { since?: Date; until?: Date },
  ): Promise<object | null>;
  recordGame(
    userId: string,
    game: {
      pulseId: string;
      gameId?: string;
      toonHandle?: string;
      pulseCharacterId?: string;
      pulseLookupAttempted?: boolean;
      displayName: string;
      race: string;
      mmr?: number;
      leagueId?: number;
      result: "Victory" | "Defeat" | "Tie";
      opening?: string;
      playedAt: Date;
    },
  ): Promise<{
    upgraded: boolean;
    from: string | null;
    to: string | null;
    mmr: number | null;
    region: string | null;
  }>;
  refreshMetadata(
    userId: string,
    game: {
      pulseId: string;
      gameId?: string;
      toonHandle?: string;
      pulseCharacterId?: string;
      pulseLookupAttempted?: boolean;
      displayName?: string;
      race: string;
      mmr?: number;
      leagueId?: number;
      playedAt: Date;
    },
  ): Promise<{
    matched: number;
    modified: number;
    upgraded: boolean;
    mmr: number | null;
    region: string | null;
  }>;
  diagnoseIdentity(
    userId: string,
    pulseId: string,
  ): Promise<{
    pulseId: string;
    toonHandle: string | null;
    pulseCharacterId: string | null;
    displayNameSample: string | null;
    region: string | null;
    mmr: number | null;
    mmrFetchedAt: string | null;
    pulseResolveAttemptedAt: string | null;
    leagueId: number | null;
    gameCount: number;
    inReplayMmrCount: number;
    pulseIdStatus: "resolved" | "unresolved" | "none";
    mmrStatus: "present" | "missing";
    findings: Array<{ code: string; severity: string; message: string }>;
  } | null>;
  retryPulseResolution(
    userId: string,
    pulseId: string,
  ): Promise<{
    resolvedPulseCharacterId: boolean;
    pulseCharacterId: string | null;
    mmr: number | null;
    region: string | null;
    gamesRestamped: number;
  } | null>;
  getPulseRaceBreakdown(
    userId: string,
    pulseId: string,
  ): Promise<{
    resolved: boolean;
    races: Array<{
      race: string;
      mmr: number;
      games: number;
      league: string | null;
      region: string | null;
    }>;
    topRace: string | null;
    topMmr: number | null;
  } | null>;
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
  distinctMyToonHandles(userId: string, limit?: number): Promise<string[]>;
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
  /** Which side of the game the phase trajectory was scored from.
   *  Echoed by the API so the client can render the panel header
   *  accurately ("What you typically do" vs "What they typically do")
   *  without re-deriving from the saved build's stored field. */
  perspective?: "you" | "opponent";
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
      kind: "build" | "oppStrategy" | "finalPhase" | "lateComp" | "oppRace";
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
    opts?: {
      includeTransitions?: boolean;
      perspective?: "you" | "opponent";
      /**
       * Optional opponent-strategy axis. When set, the matched set is
       * further restricted to games where ``opponent.strategy`` equals
       * the requested value — the BuildVsStrategyComparison drill-down
       * passes it through so the left column describes the same cell
       * as the matrix the user clicked.
       */
      strategyName?: string | null;
      /**
       * Parsed global filter bar (see util/parseQuery.parseFilters);
       * restricts the game cohort the phases are computed over.
       */
      filters?: object;
    },
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
  /** Embedded opponent block. ``strategy`` is what the StrategyPhases
   *  service filters on for the BuildVsStrategyComparison drill-down. */
  opponent: {
    displayName?: string | null;
    race?: string | null;
    strategy?: string | null;
  } | null;
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
    opts: { interval?: "day" | "week" | "month"; tz?: string },
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
  distinctMaps(userId: string): Promise<
    Array<{
      map: string;
      count: number;
      firstSeen: Date | null;
      lastSeen: Date | null;
    }>
  >;
  mapMatchups(userId: string, filters: object): Promise<object>;
  macroSummary(userId: string, filters: object): Promise<object>;
  matchupTimeseries(
    userId: string,
    opts: object,
    filters: object,
  ): Promise<object>;
  dayHourHeatmap(userId: string, opts: object, filters: object): Promise<object>;
  lengthBuckets(userId: string, filters: object): Promise<object>;
  activityCalendar(
    userId: string,
    opts: object,
    filters: object,
  ): Promise<object>;
  mmrProgression(userId: string, opts: object, filters: object): Promise<object>;
  momentum(userId: string, filters: object, opts?: object): Promise<object>;
  oppMmrBuckets(userId: string, filters: object, opts?: object): Promise<object>;
  oppMmrBucketGames(
    userId: string,
    filters: object,
    opts?: object,
  ): Promise<object>;
  myBuildMixOverTime(
    userId: string,
    opts: object,
    filters: object,
  ): Promise<object>;
  oppStrategyMixOverTime(
    userId: string,
    opts: object,
    filters: object,
  ): Promise<object>;
  mapTrend(userId: string, opts: object, filters: object): Promise<object>;
  netMmrByMatchup(userId: string, filters: object): Promise<object>;
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

export interface StrategyPhasesService {
  evaluate(
    userId: string,
    strategyName: string,
    opts?: {
      perspective?: "you" | "opponent";
      /**
       * Optional user-build axis. When set, the matched set is further
       * restricted to games where ``myBuild`` equals the requested
       * value — the BuildVsStrategyComparison drill-down passes it
       * through so the right column describes the same cell as the
       * matrix the user clicked, not the strategy's full marginal
       * across every build the user plays.
       */
      buildName?: string | null;
      /**
       * Parsed global filter bar (see util/parseQuery.parseFilters);
       * restricts the game cohort the phases are computed over.
       */
      filters?: object;
    },
  ): Promise<null | {
    name: string;
    total: number;
    perspective: "you" | "opponent";
    sampleSize: Record<string, number>;
    perPhase: Record<string, object>;
    finalPhaseDistribution: Record<string, number>;
    medianCrossings: {
      earlyMidAt: number | null;
      midAt: number | null;
      midLateAt: number | null;
      lateAt: number | null;
    };
    durationP95Sec: number;
    flags: string[];
  }>;
  evaluateByBuildName(
    userId: string,
    buildName: string,
    opts?: {
      perspective?: "you" | "opponent";
      /**
       * Optional opponent-strategy axis. When set, the matched set is
       * further restricted to games where ``opponent.strategy`` equals
       * the requested value — the drill-down passes it through so the
       * left column describes the build × strategy cell.
       */
      strategyName?: string | null;
      /**
       * Parsed global filter bar (see util/parseQuery.parseFilters);
       * restricts the game cohort the phases are computed over.
       */
      filters?: object;
    },
  ): Promise<null | {
    name: string;
    total: number;
    perspective: "you" | "opponent";
    sampleSize: Record<string, number>;
    perPhase: Record<string, object>;
    finalPhaseDistribution: Record<string, number>;
    medianCrossings: {
      earlyMidAt: number | null;
      midAt: number | null;
      midLateAt: number | null;
      lateAt: number | null;
    };
    durationP95Sec: number;
    flags: string[];
  }>;
  latestGameDateMs(userId: string): Promise<number>;
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
    opts?: {
      limit?: number;
      includeMacroBreakdown?: boolean;
      /**
       * Optional Mongo-level filter merged into the find query under
       * the user scope. Callers that already know the matchup (e.g.
       * the StrategiesTab build × strategy drill-down passing
       * ``{myBuild, "opponent.strategy"}``) push the predicate down
       * so the ``limit`` cap applies to matching games and the
       * analysis cohort doesn't get silently truncated by recency.
       */
      match?: Record<string, unknown>;
      /**
       * Parsed global filter bar (see util/parseQuery.parseFilters);
       * translated to a Mongo predicate via gamesMatchStage.
       */
      filters?: object;
    },
  ): Promise<PerGameComputeServiceListedGame[]>;
}

export interface MacroBackfillService {
  start(
    userId: string,
    opts?: { limit?: number; force?: boolean; reason?: string },
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
  agentStart(
    userId: string,
    body: { total?: number; folder?: string },
  ): Promise<{ ok: boolean; jobId: string; existing: boolean }>;
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
