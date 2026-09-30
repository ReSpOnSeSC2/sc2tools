// @ts-nocheck
"use strict";

/**
 * routes/guides.js in isolation (stub service, injected alias table):
 * retired slugs 301 to the canonical guide, the per-IP-and-path limiter is
 * bounded and scoped to /guides, query parsing clamps, and service failures reach
 * the app error handler as 500s.
 */

const express = require("express");
const request = require("supertest");
const pino = require("pino");
const { buildGuidesRouter, parseBand, parseEra } = require("../src/routes/guides");
const { buildErrorHandler } = require("../src/middleware/errorHandler");
const { GUIDE_CACHE_CONTROL } = require("../src/config/guides");

const ALIASES = {
  builds: { pvz: { "old-glaives": "stargate-into-glaives" } },
  counters: { pvz: { "old-12-pool": "12-pool" } },
};

function stubGuides() {
  return {
    index: jest.fn(async () => ({ ok: "index" })),
    sitemap: jest.fn(async () => ({ computedAt: null, entries: [] })),
    map: jest.fn(async () => null),
    matchup: jest.fn(async (matchup, opts) => ({ matchup, ...opts })),
    build: jest.fn(async (resolved) => ({ build: resolved })),
    counter: jest.fn(async (resolved) => ({ counter: resolved })),
    me: jest.fn(async (who) => ({ who })),
  };
}

function appWith(deps) {
  const app = express();
  app.use("/v1", buildGuidesRouter({
    guideSamples: { userHash: (id) => `hash:${id}` },
    auth: (req, _res, next) => {
      req.auth = { userId: "u_me", source: "clerk" };
      next();
    },
    enabled: true,
    aliases: ALIASES,
    ...deps,
  }));
  app.get("/v1/other", (_req, res) => res.json({ ok: true }));
  app.use(buildErrorHandler(pino({ level: "silent" })));
  return app;
}

describe("guides router (isolated)", () => {
  test("a retired build slug 301s to the canonical guide", async () => {
    const guides = stubGuides();
    const res = await request(appWith({ guides })).get("/v1/guides/pvz/old-glaives");
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe("/v1/guides/pvz/stargate-into-glaives");
    expect(res.headers["cache-control"]).toBe(GUIDE_CACHE_CONTROL);
    expect(res.body).toEqual({ movedTo: "/guides/pvz/stargate-into-glaives" });
    expect(guides.build).not.toHaveBeenCalled();
  });

  test("a retired counter slug 301s to the canonical counter guide", async () => {
    const res = await request(appWith({ guides: stubGuides() })).get("/v1/guides/pvz/counter/old-12-pool");
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe("/v1/guides/pvz/counter/12-pool");
    expect(res.body).toEqual({ movedTo: "/guides/pvz/counter/12-pool" });
  });

  test("/me follows an alias to the canonical build instead of redirecting", async () => {
    const guides = stubGuides();
    const res = await request(appWith({ guides })).get("/v1/guides/me/pvz/old-glaives");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(guides.me).toHaveBeenCalledWith({
      userId: "u_me", userHash: "hash:u_me", matchup: "PvZ", buildKey: "PvZ - Stargate into Glaives",
    });
  });

  test("a service failure is a 500 through the app error handler, never cacheable", async () => {
    const guides = stubGuides();
    guides.index.mockRejectedValue(new Error("mongo down"));
    const res = await request(appWith({ guides })).get("/v1/guides");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal_error");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("parseBand / parseEra clamp to known values", () => {
    expect(parseBand("league:0")).toEqual({ type: "league", value: 0, label: "Bronze" });
    expect(parseBand("league:6")).toEqual({ type: "league", value: 6, label: "Grandmaster" });
    expect(parseBand("mmr:1000")).toEqual({ type: "mmr", value: 1000, label: "<2000" });
    expect(parseBand("mmr:6500")).toEqual({ type: "mmr", value: 6500, label: "6500+" });
    expect(parseBand(["mmr:4500", "league:1"])).toEqual({ type: "mmr", value: 4500, label: "4500–5000" });
    for (const bad of ["league:7", "mmr:4250", "league:", "league:1.5", "LEAGUE:4", 4, null, undefined, {}]) {
      expect(parseBand(bad)).toBeNull();
    }
    expect(parseEra("before")).toBe("before");
    expect(parseEra("after")).toBe("after");
    expect(parseEra(" before ")).toBe("before");
    expect(parseEra("BEFORE")).toBe("after");
    expect(parseEra(undefined)).toBe("after");
  });
});

describe("guides rate limit (isolated)", () => {
  test("the limiter is bounded per IP and path, and scoped to /guides", async () => {
    const app = appWith({ guides: stubGuides(), limitPerMinute: 2 });
    expect((await request(app).get("/v1/guides/pvz")).status).toBe(200);
    // A query string shares its path's bucket rather than opening a fresh one.
    expect((await request(app).get("/v1/guides/pvz?band=league:4")).status).toBe(200);
    const limited = await request(app).get("/v1/guides/pvz?era=before");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: { code: "rate_limited", message: "rate_limited" } });
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect((await request(app).get("/v1/other")).status).toBe(200);
  });

  test("junk slugs from the shared web IP cannot drain a real guide's bucket", async () => {
    const guides = stubGuides();
    const app = appWith({ guides, limitPerMinute: 2 });
    for (const junk of ["junk-a", "junk-b", "junk-c"]) {
      expect((await request(app).get(`/v1/guides/maps/${junk}`)).status).toBe(404);
      expect((await request(app).get(`/v1/guides/maps/${junk}`)).status).toBe(404);
      expect((await request(app).get(`/v1/guides/maps/${junk}`)).status).toBe(429);
    }
    expect((await request(app).get("/v1/guides")).status).toBe(200);
    expect((await request(app).get("/v1/guides/sitemap")).status).toBe(200);
    expect((await request(app).get("/v1/guides/pvz/stargate-into-glaives")).status).toBe(200);
    expect(guides.build).toHaveBeenCalledTimes(1);
  });
});
