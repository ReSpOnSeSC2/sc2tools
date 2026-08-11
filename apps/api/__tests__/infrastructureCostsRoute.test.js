// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const {
  buildInfrastructureCostsRouter,
} = require("../src/routes/infrastructureCosts");

function appFor(service) {
  const app = express();
  app.use("/v1", buildInfrastructureCostsRouter({
    infrastructureUsage: service,
  }));
  return app;
}

const SNAPSHOT = {
  asOf: "2026-08-11T00:00:00.000Z",
  stale: false,
  estimate: true,
  archive: {
    verifiedOriginalReplays: 8,
    r2StoredBytes: 123,
    r2ObjectCount: 16,
    includes: "originals_and_analysis",
  },
  r2: {
    cycleStart: "2026-08-01T00:00:00.000Z",
    classARequests: 12,
    classBRequests: 34,
    unknownRequests: 0,
    estimatedCostUsd: {
      storageRunRate: 0,
      classAThisCycle: 0,
      classBThisCycle: 0,
      currentMonthly: 0,
    },
  },
  mongo: {
    appData: {
      logicalDataBytes: 1_000,
      allocatedDocumentBytes: 600,
      allocatedIndexBytes: 100,
      allocatedTotalBytes: 700,
      measuredAt: "2026-08-11T00:00:00.000Z",
      scope: "sc2tools_database_only",
    },
    atlas: { available: false, cluster: null, billing: null },
    planning: { monthlyUsd: 56.94 },
  },
  site: {
    fixedMonthlyEquivalentUsd: 65.19,
    nonMongoFixedMonthlyUsd: 8.25,
    pricingMode: "planning_fallback",
    estimatedCurrentMonthlyTotalUsd: 65.19,
  },
};

describe("GET /v1/public/infrastructure-costs", () => {
  test("is public, cacheable, and returns the aggregate snapshot", async () => {
    const snapshot = jest.fn(async () => SNAPSHOT);
    const res = await request(appFor({ snapshot }))
      .get("/v1/public/infrastructure-costs")
      .expect(200);

    expect(res.headers["cache-control"]).toBe(
      "public, max-age=300, s-maxage=900, stale-while-revalidate=86400",
    );
    expect(res.body).toEqual(SNAPSHOT);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  test("returns a no-store 503 without leaking an upstream error", async () => {
    const err = new Error("token-secret-value");
    err.code = "infrastructure_costs_unavailable";
    err.status = 503;
    const res = await request(appFor({
      snapshot: jest.fn(async () => { throw err; }),
    }))
      .get("/v1/public/infrastructure-costs")
      .expect(503);

    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      error: { code: "infrastructure_costs_unavailable" },
    });
    expect(JSON.stringify(res.body)).not.toContain("token-secret-value");
  });
});
