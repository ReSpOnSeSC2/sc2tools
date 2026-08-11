// @ts-nocheck
"use strict";

const {
  RenderInfrastructureClient,
  _internals,
} = require("../src/services/renderInfrastructure");

const NOW = new Date("2026-08-11T18:00:00.000Z");

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function series(values, unit = "cores") {
  return [{
    labels: [{ field: "service", value: "srv-secret-service-id" }],
    unit,
    values,
  }];
}

function point(timestamp, value) {
  return { timestamp, value };
}

function client(fetchImpl, overrides = {}) {
  return new RenderInfrastructureClient({
    config: {
      apiKey: "rnd_secret_api_key",
      serviceId: "srv-secret-service-id",
      monthlyCostUsd: 7,
    },
    fetchImpl,
    now: overrides.now || (() => NOW),
    cacheTtlMs: overrides.cacheTtlMs,
  });
}

function successfulFetch() {
  const timestamps = [
    String(new Date("2026-08-11T17:45:00.000Z").getTime() / 1000),
    "2026-08-11T17:50:00.000Z",
    String(new Date("2026-08-11T17:55:00.000Z").getTime()),
  ];
  return jest.fn(async (url, init) => {
    expect(init.method).toBe("GET");
    expect(init.headers.authorization).toBe("Bearer rnd_secret_api_key");
    if (url.includes("/services/")) {
      return response({
        id: "srv-secret-service-id",
        name: "secret-service-name",
        dashboardUrl: "https://dashboard.render.com/secret",
        suspended: "not_suspended",
        serviceDetails: {
          plan: "starter",
          numInstances: 1,
          autoscaling: { enabled: false },
        },
      });
    }
    if (url.includes("/metrics/cpu-limit?")) {
      return response(series(timestamps.map((stamp) => point(stamp, 0.5))));
    }
    if (url.includes("/metrics/cpu?")) {
      return response(series([
        point(timestamps[0], 0.25),
        point(timestamps[1], 0.35),
        point(timestamps[2], 0.4),
      ]));
    }
    if (url.includes("/metrics/memory-limit?")) {
      return response(series(timestamps.map((stamp) => point(stamp, 512))));
    }
    if (url.includes("/metrics/memory?")) {
      return response(series([
        point(timestamps[0], 300),
        point(timestamps[1], 350),
        point(timestamps[2], 400),
      ]));
    }
    throw new Error(`unexpected URL ${url}`);
  });
}

describe("RenderInfrastructureClient", () => {
  test("returns an identifier-free plan and sustained capacity snapshot", async () => {
    const fetchImpl = successfulFetch();
    const value = await client(fetchImpl).snapshot();

    expect(value).toMatchObject({
      configured: true,
      available: true,
      stale: false,
      measuredAt: "2026-08-11T17:55:00.000Z",
      fetchedAt: NOW.toISOString(),
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
        cpu: {
          averagePercent: 66.7,
          peakPercent: 80,
          latestPercent: 80,
          recentAveragePercent: 66.7,
          recentSampleCount: 3,
          sampleCount: 3,
        },
        memory: {
          averagePercent: 68.4,
          peakPercent: 78.1,
          latestPercent: 78.1,
          recentAveragePercent: 68.4,
          recentSampleCount: 3,
          sampleCount: 3,
        },
      },
      cost: {
        monthlyPlanningUsd: 7,
        basis: "operator_configured",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const urls = fetchImpl.mock.calls.map(([url]) => url);
    const metricUrl = (path) => urls.find((url) => url.includes(path));
    expect(metricUrl("/metrics/cpu?")).not.toContain("aggregationMethod");
    expect(metricUrl("/metrics/cpu-limit?")).not.toContain("aggregationMethod");
    expect(metricUrl("/metrics/memory?")).not.toContain("aggregationMethod");
    expect(metricUrl("/metrics/memory-limit?")).not.toContain("aggregationMethod");
    expect(JSON.stringify(value)).not.toMatch(
      /srv-secret|secret-service|dashboard\.render|rnd_secret/,
    );
  });

  test("does not pretend an empty metric window was measured now", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/services/")) {
        return response({
          suspended: "not_suspended",
          serviceDetails: { plan: "starter", numInstances: 1 },
        });
      }
      return response([]);
    });
    const value = await client(fetchImpl).snapshot();
    expect(value.measuredAt).toBeNull();
    expect(value.fetchedAt).toBe(NOW.toISOString());
    expect(value.metrics).toMatchObject({
      available: false,
      measuredAt: null,
      cpu: { sampleCount: 0, recentAveragePercent: null },
      memory: { sampleCount: 0, recentAveragePercent: null },
    });
  });

  test("keeps a missing configured instance count unknown", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/services/")) {
        return response({
          suspended: "not_suspended",
          serviceDetails: { plan: "starter" },
        });
      }
      return response([]);
    });

    await expect(client(fetchImpl).snapshot()).resolves.toMatchObject({
      service: { configuredInstanceCount: null },
    });
  });

  test("serves the last good aggregate as stale after a provider failure", async () => {
    let current = new Date(NOW);
    const healthy = successfulFetch();
    let fail = false;
    const fetchImpl = jest.fn((...args) => fail
      ? Promise.reject(new Error("render down"))
      : healthy(...args));
    const instance = client(fetchImpl, {
      now: () => current,
      cacheTtlMs: 10,
    });
    const first = await instance.snapshot();
    current = new Date(current.getTime() + 11);
    fail = true;
    const stale = await instance.snapshot();
    expect(stale).toMatchObject({
      stale: true,
      measuredAt: first.measuredAt,
      service: { plan: "starter" },
    });
  });
});

describe("Render metric parsing", () => {
  test("pairs per-instance usage and limits before keeping the worst ratio", () => {
    const stamp = "2026-08-11T17:55:00Z";
    const usage = [
      {
        labels: [{ field: "instance", value: "a" }],
        values: [point(stamp, 0.2)],
      },
      {
        labels: [{ field: "instance", value: "b" }],
        values: [point(stamp, 0.7)],
      },
    ];
    const limits = [
      {
        labels: [{ field: "instance", value: "a" }],
        values: [point(stamp, 0.5)],
      },
      {
        labels: [{ field: "instance", value: "b" }],
        values: [point(stamp, 1)],
      },
    ];

    expect(_internals.utilizationStats(usage, limits)).toMatchObject({
      latestPercent: 70,
      peakPercent: 70,
      sampleCount: 1,
    });
  });

  test("accepts epoch seconds, epoch milliseconds, and ISO timestamps", () => {
    expect(_internals.metricPoints(series([
      point("1700000000", 1),
      point("1700000300000", 2),
      point("2026-08-11T17:55:00Z", 3),
    ]))).toEqual([
      {
        timestamp: "2023-11-14T22:13:20.000Z",
        value: 1,
        signature: "service=srv-secret-service-id",
      },
      {
        timestamp: "2023-11-14T22:18:20.000Z",
        value: 2,
        signature: "service=srv-secret-service-id",
      },
      {
        timestamp: "2026-08-11T17:55:00.000Z",
        value: 3,
        signature: "service=srv-secret-service-id",
      },
    ]);
  });

  test("ignores null and blank provider datapoints instead of coercing zero", () => {
    expect(_internals.metricPoints(series([
      point("2026-08-11T17:40:00Z", null),
      point("2026-08-11T17:45:00Z", ""),
      point("2026-08-11T17:50:00Z", undefined),
      point("2026-08-11T17:55:00Z", 0),
    ]))).toEqual([{
      timestamp: "2026-08-11T17:55:00.000Z",
      value: 0,
      signature: "service=srv-secret-service-id",
    }]);
  });
});
