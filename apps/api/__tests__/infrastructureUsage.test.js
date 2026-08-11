// @ts-nocheck
"use strict";

const {
  InfrastructureUsageService,
  _internals,
} = require("../src/services/infrastructureUsage");

const NOW = new Date("2026-08-11T15:00:00.000Z");

function analyticsBody(overrides = {}) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            storage: [
              {
                max: {
                  objectCount: 30,
                  uploadCount: 0,
                  payloadSize: 12_000_000_001,
                  metadataSize: 4_096,
                  ...(overrides.storage || {}),
                },
                dimensions: { datetime: "2026-08-11T14:45:00.000Z" },
              },
            ],
            operations: overrides.operations || [
              operation("PutObject", 1_000_001),
              operation("GetObject", 10_000_001),
              operation("DeleteObject", 12),
              operation("FutureAction", 7),
            ],
          },
        ],
      },
    },
  };
}

function operation(actionType, requests) {
  return { dimensions: { actionType }, sum: { requests } };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function configured(overrides = {}) {
  return {
    accountId: "account-secret-id",
    apiToken: "token-secret-value",
    bucket: "private-bucket-name",
    billingCycleDay: 5,
    ...overrides,
  };
}

function service(opts = {}) {
  return new InfrastructureUsageService({
    games: opts.games || { countDocuments: jest.fn(async () => 15) },
    mongoDb: opts.mongoDb || {
      command: jest.fn(async () => ({
        dataSize: 1_200,
        storageSize: 800,
        indexSize: 200,
      })),
    },
    cloudflareAnalytics:
      opts.cloudflareAnalytics === undefined
        ? configured()
        : opts.cloudflareAnalytics,
    fetchImpl:
      opts.fetchImpl || jest.fn(async () => response(analyticsBody())),
    now: opts.now || (() => NOW),
    cacheTtlMs: opts.cacheTtlMs,
    errorRetryMs: opts.errorRetryMs,
    timeoutMs: opts.timeoutMs,
    atlasAdmin: opts.atlasAdmin,
    atlasClient: opts.atlasClient,
    renderAdmin: opts.renderAdmin,
    renderClient: opts.renderClient,
  });
}

describe("InfrastructureUsageService", () => {
  test("returns only aggregate usage and integer-mill costs", async () => {
    const fetchImpl = jest.fn(async () => response(analyticsBody()));
    const games = { countDocuments: jest.fn(async () => 15) };
    const result = await service({ fetchImpl, games }).snapshot();

    expect(result).toEqual({
      asOf: "2026-08-11T14:45:00.000Z",
      stale: false,
      estimate: true,
      archive: {
        verifiedOriginalReplays: 15,
        r2StoredBytes: 12_000_000_001,
        r2ObjectCount: 30,
        includes: "originals_and_analysis",
      },
      r2: {
        cycleStart: "2026-08-05T00:00:00.000Z",
        classARequests: 1_000_001,
        classBRequests: 10_000_001,
        unknownRequests: 7,
        estimatedCostUsd: {
          storageRunRate: 0.045,
          classAThisCycle: 4.5,
          classBThisCycle: 0.36,
          currentMonthly: 4.905,
        },
      },
      mongo: {
        appData: {
          logicalDataBytes: 1_200,
          allocatedDocumentBytes: 800,
          allocatedIndexBytes: 200,
          allocatedTotalBytes: 1_000,
          measuredAt: NOW.toISOString(),
          scope: "sc2tools_database_only",
        },
        atlas: {
          available: false,
          cluster: null,
          billing: null,
        },
        planning: { monthlyUsd: 56.94 },
      },
      site: {
        fixedMonthlyEquivalentUsd: 65.19,
        nonMongoFixedMonthlyUsd: 8.25,
        pricingMode: "planning_fallback",
        estimatedCurrentMonthlyTotalUsd: 70.095,
      },
    });
    expect(games.countDocuments).toHaveBeenCalledWith(
      { "replayFile.storedAt": { $exists: true } },
      { maxTimeMS: 8_000 },
    );

    const request = fetchImpl.mock.calls[0];
    const body = JSON.parse(request[1].body);
    expect(request[0]).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(request[1].headers.authorization).toBe("Bearer token-secret-value");
    expect(body.variables).toMatchObject({
      accountTag: "account-secret-id",
      bucketName: "private-bucket-name",
      cycleStart: "2026-08-05T00:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /account-secret|token-secret|private-bucket/,
    );
  });

  test("uses the Atlas projection while stripping provider identifiers", async () => {
    const atlasClient = {
      snapshot: jest.fn(async () => ({
        available: true,
        measuredAt: NOW.toISOString(),
        cluster: {
          tier: "M10",
          provider: "SECRET_PROVIDER",
          region: "SECRET_REGION",
          clusterName: "secret-cluster-name",
          provisionedDiskGb: 10,
          autoExpandStorage: true,
          diskUsedBytes: 3_954_452_070,
          diskCapacityBytes: 10_632_560_640,
          diskMeasuredAt: "2026-08-11T14:40:00.000Z",
        },
        billing: {
          available: true,
          cycleStart: "2026-08-01T00:00:00.000Z",
          cycleEnd: "2026-09-01T00:00:00.000Z",
          postedThrough: "2026-08-11T00:00:00.000Z",
          postedCycleCents: 2_000,
          categoryCents: {
            compute: 1_800,
            storage: 200,
            transfer: 0,
            other: 0,
          },
          projectedMonthlyRunRateCents: 6_000,
          projectedMonthlyRunRateUsd: 60,
          rawSku: "SECRET_SKU",
        },
      })),
    };
    const result = await service({ atlasClient }).snapshot();

    expect(result.mongo).toEqual({
      appData: {
        logicalDataBytes: 1_200,
        allocatedDocumentBytes: 800,
        allocatedIndexBytes: 200,
        allocatedTotalBytes: 1_000,
        measuredAt: NOW.toISOString(),
        scope: "sc2tools_database_only",
      },
      atlas: {
        available: true,
        cluster: {
          tier: "M10",
          provisionedDiskGb: 10,
          diskUsedBytes: 3_954_452_070,
          diskCapacityBytes: 10_632_560_640,
          diskMeasuredAt: "2026-08-11T14:40:00.000Z",
          autoExpandStorage: true,
        },
        billing: {
          available: true,
          cycleStart: "2026-08-01T00:00:00.000Z",
          cycleEnd: "2026-09-01T00:00:00.000Z",
          postedThrough: "2026-08-11T00:00:00.000Z",
          postedCycleCents: 2_000,
          categoryCents: {
            compute: 1_800,
            storage: 200,
            transfer: 0,
            other: 0,
          },
          projectedMonthlyRunRateCents: 6_000,
          projectedMonthlyRunRateUsd: 60,
        },
      },
      planning: { monthlyUsd: 56.94 },
    });
    expect(result.site).toMatchObject({
      nonMongoFixedMonthlyUsd: 8.25,
      pricingMode: "atlas_projected",
      estimatedCurrentMonthlyTotalUsd: 73.155,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET_PROVIDER|SECRET_REGION|secret-cluster|SECRET_SKU/,
    );
  });

  test("keeps the Mongo planning fallback when Atlas has no matched charges", async () => {
    const atlasClient = {
      snapshot: jest.fn(async () => ({
        available: true,
        measuredAt: NOW.toISOString(),
        cluster: {
          tier: "M10",
          provisionedDiskGb: 10,
          autoExpandStorage: true,
          diskUsedBytes: 1_000,
          diskCapacityBytes: 10_000,
        },
        billing: {
          available: false,
          projectedMonthlyRunRateCents: null,
          projectedMonthlyRunRateUsd: null,
          lineItemCount: 0,
          errorCode: "atlas_billing_no_matching_line_items",
        },
      })),
    };
    const result = await service({ atlasClient }).snapshot();
    expect(result.site).toMatchObject({
      pricingMode: "planning_fallback",
      fixedMonthlyEquivalentUsd: 65.19,
      estimatedCurrentMonthlyTotalUsd: 70.095,
    });
    expect(result.mongo.atlas.billing).toMatchObject({
      available: false,
      projectedMonthlyRunRateCents: null,
    });
  });

  test("reports live app database bytes without treating usage as Atlas price", async () => {
    const mongoDb = {
      command: jest.fn(async () => ({
        dataSize: 3_000,
        storageSize: 2_000,
        indexSize: 500,
      })),
    };
    await expect(service({ mongoDb }).mongoStorageSnapshot()).resolves.toEqual({
      appData: {
        logicalDataBytes: 3_000,
        allocatedDocumentBytes: 2_000,
        allocatedIndexBytes: 500,
        allocatedTotalBytes: 2_500,
        scope: "sc2tools_database_only",
        measuredAt: NOW.toISOString(),
      },
      pricing: {
        monthlyPlanningEstimateUsd: 56.94,
        includedInSiteFixedMonthlyEquivalent: true,
        estimate: true,
        basis: "repo_budget_assumption",
      },
      atlas: {
        configured: false,
        available: false,
        measuredAt: null,
        cluster: null,
        billing: null,
        credential: {
          expiresAt: null,
          daysRemaining: null,
          expiringSoon: false,
        },
        errorCode: "not_configured",
      },
    });
    expect(mongoDb.command).toHaveBeenCalledWith({
      dbStats: 1,
      scale: 1,
      maxTimeMS: 8_000,
    });
  });

  test("admin diagnostics expose config health but never provider identifiers", async () => {
    const atlasClient = {
      snapshot: jest.fn(async () => ({
        available: true,
        measuredAt: NOW.toISOString(),
        cluster: {
          tier: "M10",
          provider: "GCP",
          region: "WESTERN_US",
          provisionedDiskGb: 10,
          autoExpandStorage: true,
          diskUsedBytes: 3_954_452_070,
          diskCapacityBytes: 10_632_560_640,
          diskMeasuredAt: NOW.toISOString(),
        },
        billing: {
          available: true,
          postedCycleCents: 2_859,
          projectedMonthlyRunRateCents: 8_863,
        },
        configErrorCode: null,
      })),
    };
    const instance = service({
      atlasClient,
      atlasAdmin: {
        ...configured(),
        secretExpiresAt: "2028-01-01T00:00:00.000Z",
      },
    });
    const status = await instance.adminStatus();
    expect(status).toMatchObject({
      cloudflareAnalytics: {
        configured: true,
        available: true,
        stale: false,
      },
      mongo: {
        atlas: {
          configured: true,
          available: true,
          cluster: { tier: "M10", provisionedDiskGb: 10 },
          credential: {
            expiresAt: "2028-01-01T00:00:00.000Z",
            daysRemaining: expect.any(Number),
            expiringSoon: false,
          },
        },
      },
    });
    expect(JSON.stringify(status)).not.toMatch(
      /service-account-secret|account-secret|token-secret|private-bucket/,
    );
  });

  test("builds the private admin cost and capacity contract independently", async () => {
    const renderClient = {
      snapshot: jest.fn(async () => ({
        configured: true,
        available: true,
        stale: false,
        measuredAt: NOW.toISOString(),
        serviceId: "SECRET_RENDER_ID",
        service: {
          plan: "starter",
          configuredInstanceCount: 1,
          suspended: false,
          autoscalingEnabled: false,
        },
        metrics: {
          available: true,
          windowMinutes: 60,
          sustainedWindowMinutes: 15,
          resolutionSeconds: 300,
          measuredAt: NOW.toISOString(),
          cpu: {
            averagePercent: 20,
            peakPercent: 35,
            latestPercent: 25,
            recentAveragePercent: 25,
            recentSampleCount: 3,
            sampleCount: 12,
          },
          memory: {
            averagePercent: 40,
            peakPercent: 50,
            latestPercent: 42,
            recentAveragePercent: 42,
            recentSampleCount: 3,
            sampleCount: 12,
          },
        },
        cost: { monthlyPlanningUsd: 7 },
      })),
    };
    const result = await service({ renderClient }).adminSnapshot();
    expect(result).toMatchObject({
      overallStatus: "watch",
      providers: {
        cloudflare: {
          configured: true,
          available: true,
          usage: { storedBytes: 12_000_000_001, objectCount: 30 },
          cost: { estimatedCurrentMonthlyUsd: 4.905 },
        },
        mongo: {
          available: true,
          monitoringAvailable: false,
          status: "watch",
        },
        render: {
          available: true,
          status: "healthy",
          service: { plan: "starter", instanceCount: 1 },
        },
      },
    });
    expect(result.advisories).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "atlas_monitoring_not_configured" }),
    ]));
    expect(JSON.stringify(result)).not.toMatch(/SECRET_RENDER_ID/);
  });

  test("caches for 15 minutes and coalesces concurrent refreshes", async () => {
    let resolveFetch;
    const fetchImpl = jest.fn(
      () => new Promise((resolve) => { resolveFetch = resolve; }),
    );
    const games = { countDocuments: jest.fn(async () => 3) };
    const instance = service({ fetchImpl, games });

    const first = instance.snapshot();
    const second = instance.snapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch(response(analyticsBody()));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);

    await instance.snapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(games.countDocuments).toHaveBeenCalledTimes(1);
  });

  test("serves the last good snapshot as stale after a refresh failure", async () => {
    let current = new Date(NOW);
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(analyticsBody()))
      .mockRejectedValueOnce(new Error("cloudflare down"));
    const instance = service({
      fetchImpl,
      now: () => current,
      cacheTtlMs: 10,
      errorRetryMs: 100,
    });
    const fresh = await instance.snapshot();
    current = new Date(current.getTime() + 11);
    const stale = await instance.snapshot();

    expect(fresh.stale).toBe(false);
    expect(stale).toMatchObject({
      stale: true,
      asOf: fresh.asOf,
    });
    await instance.snapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("returns 503 semantics when unconfigured or no snapshot exists", async () => {
    await expect(service({ cloudflareAnalytics: null }).snapshot())
      .rejects.toMatchObject({
        status: 503,
        code: "infrastructure_costs_unavailable",
      });
    await expect(service({
      fetchImpl: jest.fn(async () => response({}, 500)),
    }).snapshot()).rejects.toMatchObject({
      status: 503,
      code: "infrastructure_costs_unavailable",
    });
  });

  test("aborts a provider request at the configured timeout", async () => {
    const fetchImpl = jest.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    await expect(service({ fetchImpl, timeoutMs: 5 }).snapshot())
      .rejects.toMatchObject({ status: 503 });
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

describe("infrastructure usage cost model", () => {
  test("applies decimal-GB free storage and rounded billing units", () => {
    expect(_internals.calculateCosts({
      payloadBytes: 10_000_000_000,
      classARequests: 1_000_000,
      classBRequests: 10_000_000,
    })).toMatchObject({
      storageMonthlyMills: 0,
      classAMonthlyMills: 0,
      classBMonthlyMills: 0,
      estimatedTotalMonthlyMills: 65_190,
    });
    expect(_internals.calculateCosts({
      payloadBytes: 10_000_000_001,
      classARequests: 2_000_001,
      classBRequests: 11_000_001,
    })).toMatchObject({
      storageMonthlyMills: 15,
      classAMonthlyMills: 9_000,
      classBMonthlyMills: 720,
    });
  });

  test("classifies official free/A/B actions and exposes unknown requests", () => {
    expect(_internals.classifyOperations([
      operation("PutObject", 2),
      operation("CopyObject", 3),
      operation("HeadObject", 5),
      operation("GetObject", 7),
      operation("DeleteObject", 11),
      operation("NewCloudflareAction", 13),
    ])).toEqual({
      classARequests: 5,
      classBRequests: 12,
      freeRequests: 11,
      unknownRequests: 13,
    });
  });

  test("computes UTC custom billing-cycle boundaries", () => {
    expect(_internals.billingCycleStart(
      new Date("2026-08-11T01:00:00Z"),
      5,
    ).toISOString()).toBe("2026-08-05T00:00:00.000Z");
    expect(_internals.billingCycleStart(
      new Date("2026-08-03T01:00:00Z"),
      5,
    ).toISOString()).toBe("2026-07-05T00:00:00.000Z");
  });
});
