// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { buildAdminRouter } = require("../src/routes/admin");
const { readPersonalChartCache } = require("../src/util/adminCacheHealth");
const { UserCache, LIMITS } = require("../src/middleware/userCache");

const values = (patch = {}) => ({ hit: 3, miss: 4, entries: 2, bytes: 1000, reserved_bytes: 512, ...patch });
function fixture(userCache, failure) {
  const health = jest.fn(async () => {
    if (failure) throw failure;
    return Object.freeze({ mongo: { ok: true }, runtime: { nodeVersion: "fixture" }, unchanged: true });
  });
  const app = express();
  app.use("/v1", buildAdminRouter({
    admin: { health }, userCache,
    auth: (req, res, next) => {
      const bearer = req.headers.authorization;
      if (!["Bearer admin", "Bearer reader"].includes(bearer)) { res.status(401).json({ error: { code: "unauthorized" } }); return; }
      req.auth = { userId: bearer === "Bearer admin" ? "admin" : "reader" }; next();
    },
    isAdmin: req => req.auth.userId === "admin",
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: { code: error.code || "health_failed" } }));
  return { app, health };
}
const get = app => request(app).get("/v1/admin/health").set("authorization", "Bearer admin");

describe("personal chart cache health projection", () => {
  test("OFF never reads counters, even if the getter throws", () => {
    const counters = jest.fn(() => { throw new Error("must not collect while off"); });
    expect(readPersonalChartCache({ enabled: false, get counters() { return counters(); } })).toEqual({ enabled: false, counters: null });
    expect(counters).not.toHaveBeenCalled();
  });
  test("copies only selected actual getter scalars once, without keys or owner data", () => {
    const revisions = { enabled: true, addInvalidator: jest.fn(), counters: { privateOwner: "not a metric" } };
    const cache = new UserCache(revisions, { enabled: true });
    cache.stats.hit = 3; cache.stats.miss = 4;
    const snapshot = readPersonalChartCache(cache);
    expect(snapshot).toEqual({ enabled: true, counters: values({ entries: 0, bytes: 0, reserved_bytes: 0 }) });
    expect(JSON.stringify(snapshot)).not.toMatch(/privateOwner|tagSalt|completed|pending|owners|revisions/);
    expect(cache.stats.hit).toBe(3); expect(cache.stats.miss).toBe(4);
    const counters = jest.fn(() => ({ ...values(), userId: "secret", query: "secret", extra: 1 }));
    expect(readPersonalChartCache({ enabled: true, get counters() { return counters(); } })).toEqual({ enabled: true, counters: values() });
    expect(counters).toHaveBeenCalledTimes(1);
  });
  test.each([
    undefined, null, [], {}, { enabled: "false" }, { enabled: true }, { enabled: true, counters: null },
    ...[NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(hit => ({ enabled: true, counters: values({ hit }) })),
    { enabled: true, counters: values({ entries: LIMITS.entries + 1 }) },
    { enabled: true, counters: values({ bytes: LIMITS.bytes + 1 }) },
    { enabled: true, counters: values({ bytes: LIMITS.bytes, reserved_bytes: 1 }) },
    { enabled: true, counters: values({ miss: undefined }) },
  ])("does not manufacture status or counters from malformed input %#", source => {
    expect(readPersonalChartCache(source)).toBeNull();
  });
  test("accepts the exact default accounting edges", () => {
    const counters = values({ hit: Number.MAX_SAFE_INTEGER, entries: LIMITS.entries, bytes: LIMITS.bytes - 1, reserved_bytes: 1 });
    expect(readPersonalChartCache({ enabled: true, counters })).toEqual({ enabled: true, counters });
  });
});

describe("existing authenticated admin health route", () => {
  test("authorization precedes any cache inspection", async () => {
    const enabled = jest.fn(() => false), counters = jest.fn(() => values());
    const { app, health } = fixture({ get enabled() { return enabled(); }, get counters() { return counters(); } });
    expect((await request(app).get("/v1/admin/health")).status).toBe(401);
    expect((await request(app).get("/v1/admin/health").set("authorization", "Bearer reader")).status).toBe(403);
    expect(health).not.toHaveBeenCalled(); expect(enabled).not.toHaveBeenCalled(); expect(counters).not.toHaveBeenCalled();
  });
  test("adds OFF status to the same single health answer without reading counters", async () => {
    const counters = jest.fn(() => { throw new Error("unnecessary work"); });
    const { app, health } = fixture({ enabled: false, get counters() { return counters(); } });
    const response = await get(app);
    expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toEqual({ mongo: { ok: true }, runtime: { nodeVersion: "fixture" }, unchanged: true,
      personalChartCache: { enabled: false, counters: null } });
    expect(health).toHaveBeenCalledTimes(1); expect(counters).not.toHaveBeenCalled();
  });
  test("exposes real enabled counters without serializing cache internals or extra work", async () => {
    const counters = jest.fn(() => ({ ...values(), userId: "private-owner", query: "private-query" }));
    const { app, health } = fixture({ enabled: true, get counters() { return counters(); }, tagSalt: "secret", completed: new Map() });
    const response = await get(app);
    expect(response.status).toBe(200); expect(response.body.personalChartCache).toEqual({ enabled: true, counters: values() });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(health).toHaveBeenCalledTimes(1); expect(counters).toHaveBeenCalledTimes(1);
    expect(response.text).not.toMatch(/private-owner|private-query|tagSalt|completed/);
  });
  test.each([undefined, { enabled: true, counters: values({ hit: -1 }) }, { enabled: true, get counters() { throw new Error("reporting unavailable"); } }])(
    "missing or malformed reporting preserves a successful health response %#", async source => {
      const { app, health } = fixture(source); const response = await get(app);
      expect(response.status).toBe(200); expect(response.body.personalChartCache).toBeNull();
      expect(response.body.unchanged).toBe(true); expect(health).toHaveBeenCalledTimes(1);
    },
  );
  test("an existing health failure remains an uncached failure without collecting counters", async () => {
    const counters = jest.fn(() => values()); const { app, health } = fixture({ enabled: true, get counters() { return counters(); } }, new Error("probe failed"));
    const response = await get(app);
    expect(response.status).toBe(500); expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toEqual({ error: { code: "health_failed" } });
    expect(health).toHaveBeenCalledTimes(1); expect(counters).not.toHaveBeenCalled();
  });
});
