// @ts-nocheck
"use strict";

/* eslint-disable max-lines-per-function */

const {
  RuntimeCapacityRegistry,
  buildRuntimeCapacityMonitor,
  RUNTIME_CAPACITY_INTERVAL_MS,
} = require("../src/services/runtimeCapacity");
const { PulseMmrService } = require("../src/services/pulseMmr");
const {
  SessionResolutionGate,
} = require("../src/services/sessionResolutionGate");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { OverlayTokensService } = require("../src/services/overlayTokens");
const {
  YoutubePollCoordinator,
} = require("../src/services/youtubeLiveChat");
const {
  createAnalysisCorpusAdmission,
} = require("../src/routes/games");
const { OpponentsService } = require("../src/services/opponents");
const { OverlayLiveService } = require("../src/services/overlayLive");
const { GameDetailsService } = require("../src/services/gameDetails");
const { R2DetailsStore } = require("../src/services/gameDetailsStore");
const { MLService } = require("../src/services/ml");
const {
  _internals: { registerRuntimeCapacityProviders },
} = require("../src/app");

describe("runtime capacity monitor", () => {
  test("logs the complete memory/socket shape and owns one unref timer", () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const timer = { unref: jest.fn() };
    let tick = null;
    const setIntervalImpl = jest.fn((callback) => {
      tick = callback;
      return timer;
    });
    const clearIntervalImpl = jest.fn();
    const registry = new RuntimeCapacityRegistry();
    registry.register("pulse", () => ({ requestInflight: 2 }));
    const monitor = buildRuntimeCapacityMonitor({
      logger,
      io: { engine: { clientsCount: 7 } },
      registry,
      memoryUsage: () => ({
        heapUsed: 11,
        heapTotal: 22,
        rss: 33,
        external: 44,
        arrayBuffers: 55,
      }),
      heapStatistics: () => ({ heap_size_limit: 66 }),
      setIntervalImpl,
      clearIntervalImpl,
    });

    monitor.start();
    monitor.start();

    expect(setIntervalImpl).toHaveBeenCalledTimes(1);
    expect(setIntervalImpl).toHaveBeenCalledWith(
      expect.any(Function),
      RUNTIME_CAPACITY_INTERVAL_MS,
    );
    expect(timer.unref).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenLastCalledWith(
      {
        memory: {
          heapUsed: 11,
          heapTotal: 22,
          rss: 33,
          external: 44,
          arrayBuffers: 55,
          heapSizeLimit: 66,
        },
        socketClients: 7,
        capacity: { pulse: { requestInflight: 2 } },
        capacityProviderErrors: 0,
      },
      "runtime_capacity",
    );

    tick();
    expect(logger.info).toHaveBeenCalledTimes(2);
    monitor.stop();
    monitor.stop();
    expect(clearIntervalImpl).toHaveBeenCalledTimes(1);
    expect(clearIntervalImpl).toHaveBeenCalledWith(timer);
    expect(monitor.isRunning()).toBe(false);
  });

  test("fails closed on sensitive values and broken providers", () => {
    const registry = new RuntimeCapacityRegistry();
    expect(() => registry.register("privateUser42", () => ({ active: 1 })))
      .toThrow("runtime capacity source name is invalid");
    registry.register("session", () => ({
      tasks: 3,
      active: true,
      userId: "user-secret",
      token: "token-secret",
      nested: {
        queued: 4,
        cacheKey: "hashed-secret",
        note: "also omitted",
      },
      rawEntries: ["secret"],
    }));
    registry.register("customReclassification", () => ({
      queuedAccounts: 5,
      activeUserId: "private-user-id",
    }));
    registry.register("youtubeRelay", () => {
      throw new Error("token-secret");
    });

    expect(registry.snapshot()).toEqual({
      sources: {
        session: {
          tasks: 3,
          active: true,
          nested: { queued: 4 },
        },
        customReclassification: { queuedAccounts: 5 },
      },
      providerErrors: 1,
    });
  });

  test("registers the new heavy-work gates as numeric-only sources", () => {
    const registry = new RuntimeCapacityRegistry();
    registerRuntimeCapacityProviders(registry, {
      opponents: {
        profileAnalysisCapacitySnapshot: () => ({
          active: 1,
          queued: 2,
          maxActive: 2,
          maxWaiters: 8,
          userId: "private-user-id",
        }),
      },
      overlayLive: {
        enrichmentCapacitySnapshot: () => ({
          active: 1,
          queued: 3,
          flights: 4,
          maxActive: 2,
          maxWaiters: 8,
          maxSubscribers: 32,
        }),
      },
      gameDetails: {
        bulkReadCapacitySnapshot: () => ({
          active: 2,
          queued: 5,
          maxActive: 2,
          maxWaiters: 32,
        }),
      },
      ml: {
        trainingCapacitySnapshot: () => ({
          active: 1,
          reserved: 0,
          maxActive: 1,
        }),
      },
    });

    expect(registry.snapshot()).toEqual({
      sources: {
        opponentProfiles: {
          active: 1,
          queued: 2,
          maxActive: 2,
          maxWaiters: 8,
        },
        overlayEnrichment: {
          active: 1,
          queued: 3,
          flights: 4,
          maxActive: 2,
          maxWaiters: 8,
          maxSubscribers: 32,
        },
        gameDetailsHeavyIo: {
          active: 2,
          queued: 5,
          maxActive: 2,
          maxWaiters: 32,
        },
        mlTraining: { active: 1, reserved: 0, maxActive: 1 },
      },
      providerErrors: 0,
    });
  });
});

describe("capacity snapshot providers", () => {
  test("report cardinalities without returning identities or cache keys", async () => {
    let finishSession;
    const sessionGate = new SessionResolutionGate();
    const pendingSession = new Promise((resolve) => {
      finishSession = resolve;
    });
    const first = sessionGate.resolve(
      "private-user-id",
      "America/New_York",
      { reuseRecent: true },
      () => pendingSession,
    );
    const second = sessionGate.resolve(
      "private-user-id",
      "America/New_York",
      { reuseRecent: true },
      () => pendingSession,
    );
    expect(sessionGate.capacitySnapshot()).toEqual(
      expect.objectContaining({ lanes: 1, tasks: 1, subscribers: 2 }),
    );

    const pulse = new PulseMmrService({ fetchImpl: null });
    expect(pulse.capacitySnapshot()).toEqual(
      expect.objectContaining({
        requestInflight: 0,
        requestSubscribers: 0,
        maxRequestInflight: 2,
      }),
    );

    const customBuilds = new CustomBuildsService({
      customBuilds: {},
      customBuildJobs: {},
    });
    customBuilds._reclassifyQueuedUsers.add("private-user-id");
    expect(customBuilds.capacitySnapshot()).toEqual(
      expect.objectContaining({
        queuedAccounts: 1,
        reclassificationActive: false,
      }),
    );

    const overlayTokens = new OverlayTokensService({ overlayTokens: {} });
    overlayTokens.resolveCache.set("private-token-hash", {
      expiresAt: Date.now() + 1000,
      value: {},
    });
    expect(overlayTokens.capacitySnapshot()).toEqual({
      resolveCacheEntries: 1,
      lastSeenWriteEntries: 0,
      resolveInflight: 0,
      maxResolveCacheEntries: 256,
      maxLastSeenWriteEntries: 512,
      maxResolveInflight: 16,
    });

    const youtube = new YoutubePollCoordinator({ fetchImpl: jest.fn() });
    expect(youtube.capacitySnapshot()).toEqual({
      activeRequests: 0,
      subscribers: 0,
      cachedResponses: 0,
      maxActiveRequests: 2,
      maxSubscribersPerRequest: 8,
      maxCachedResponses: 4,
    });

    const corpus = createAnalysisCorpusAdmission({
      maxActive: 1,
      maxWaiters: 1,
    });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const releaseFirst = await corpus.acquire(firstAbort.signal);
    const queued = corpus.acquire(secondAbort.signal);
    expect(corpus.capacitySnapshot()).toEqual({
      activeRequests: 1,
      queuedRequests: 1,
      maxActiveRequests: 1,
      maxQueuedRequests: 1,
    });
    releaseFirst();
    const releaseSecond = await queued;
    releaseSecond();

    const opponents = new OpponentsService(
      { opponents: {}, games: {} },
      Buffer.from("test-pepper"),
    );
    expect(opponents.profileAnalysisCapacitySnapshot()).toEqual({
      active: 0,
      queued: 0,
      maxActive: 2,
      maxWaiters: 8,
    });

    const overlayLive = new OverlayLiveService({ games: {}, opponents: {} });
    expect(overlayLive.enrichmentCapacitySnapshot()).toEqual({
      active: 0,
      queued: 0,
      flights: 0,
      maxActive: 2,
      maxWaiters: 8,
      maxSubscribers: 32,
    });

    const r2Store = new R2DetailsStore({
      client: {},
      bucket: "test-bucket",
      gameDetailsCollection: {},
    });
    const gameDetails = new GameDetailsService(r2Store);
    const detailReleases = await Promise.all(
      Array.from({ length: 2 }, () => r2Store._acquireBulkReadSlot()),
    );
    const queuedDetail = r2Store._acquireBulkReadSlot();
    expect(gameDetails.bulkReadCapacitySnapshot()).toEqual({
      active: 2,
      queued: 1,
      maxActive: 2,
      maxWaiters: 32,
    });
    detailReleases.shift()();
    const queuedDetailRelease = await queuedDetail;
    queuedDetailRelease();
    detailReleases.forEach((release) => release());

    const ml = new MLService({});
    ml._activeJobs.set("private-user-id", { cancelled: false });
    ml._trainingReservations.add("another-private-user-id");
    expect(ml.trainingCapacitySnapshot()).toEqual({
      active: 1,
      reserved: 1,
      maxActive: 1,
    });
    ml._activeJobs.clear();
    ml._trainingReservations.clear();

    finishSession({ games: 0 });
    await Promise.all([first, second]);

    const serialized = JSON.stringify({
      session: sessionGate.capacitySnapshot(),
      pulse: pulse.capacitySnapshot(),
      custom: customBuilds.capacitySnapshot(),
      overlay: overlayTokens.capacitySnapshot(),
      youtube: youtube.capacitySnapshot(),
      corpus: corpus.capacitySnapshot(),
      opponents: opponents.profileAnalysisCapacitySnapshot(),
      liveEnrichment: overlayLive.enrichmentCapacitySnapshot(),
      gameDetails: gameDetails.bulkReadCapacitySnapshot(),
      mlTraining: ml.trainingCapacitySnapshot(),
    });
    expect(serialized).not.toContain("private-user-id");
    expect(serialized).not.toContain("private-token-hash");
    expect(serialized).not.toContain("America/New_York");
  });
});
