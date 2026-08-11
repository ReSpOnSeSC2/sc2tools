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
      site: {
        fixedMonthlyEquivalentUsd: 65.19,
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
