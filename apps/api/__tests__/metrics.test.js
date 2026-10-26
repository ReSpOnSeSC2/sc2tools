// @ts-nocheck
"use strict";

/**
 * /v1/metrics — Prometheus exposition behind a static bearer token.
 * prom-client was a dependency for months without a route; this locks
 * in (a) the token gate and (b) that the LiveGameBroker counters are
 * exposed with live values at scrape time.
 */

const express = require("express");
const request = require("supertest");
const { buildMetricsRouter } = require("../src/routes/metrics");

function buildApp({ broker, guideSamples, userCache } = {}) {
  const app = express();
  app.use(buildMetricsRouter({ token: "scrape-token", liveGameBroker: broker, guideSamples, userCache }));
  return app;
}

describe("GET /metrics", () => {
  test("opt-in chart cache exposes only fixed live gauges behind the existing token", async () => {
    const userCache = { enabled: true, counters: { hit: 3, miss: 4, bytes: 123, reserved_bytes: 512, pinned_bytes: 64, active: 2, guard_active: 16, guard_rejected: 3 } };
    const app = buildApp({ userCache }); expect((await request(app).get("/metrics")).status).toBe(401);
    const res = await request(app).get("/metrics").set("authorization", "Bearer scrape-token");
    expect(res.text).toContain("sc2tools_user_cache_hit 3"); expect(res.text).toContain("sc2tools_user_cache_bytes 123");
    expect(res.text).toContain("sc2tools_user_cache_guard_active 16"); expect(res.text).toContain("sc2tools_user_cache_guard_rejected 3");
    expect(res.text).not.toMatch(/userId|tokenHash|query=/);
    userCache.counters.bytes = 19;
    expect((await request(app).get("/metrics").set("authorization", "Bearer scrape-token")).text).toContain("sc2tools_user_cache_bytes 19");
    const off = await request(buildApp({ userCache: { ...userCache, enabled: false } })).get("/metrics").set("authorization", "Bearer scrape-token");
    expect(off.text).not.toContain("sc2tools_user_cache_");
  });
  test("401 without the bearer token", async () => {
    const app = buildApp();
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(401);
  });

  test("401 with a wrong token", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/metrics")
      .set("authorization", "Bearer nope");
    expect(res.status).toBe(401);
  });

  test("200 with process defaults and live broker counters", async () => {
    const broker = {
      counters: { published: 7, sse_emit_ok: 3 },
    };
    const app = buildApp({ broker });
    const res = await request(app)
      .get("/metrics")
      .set("authorization", "Bearer scrape-token");
    expect(res.status).toBe(200);
    expect(res.text).toContain("process_cpu_user_seconds_total");
    expect(res.text).toContain("sc2tools_live_broker_published 7");
    // Counters are read at scrape time, not snapshot at boot.
    broker.counters.published = 9;
    const res2 = await request(app)
      .get("/metrics")
      .set("authorization", "Bearer scrape-token");
    expect(res2.text).toContain("sc2tools_live_broker_published 9");
  });

  test("guide sample capture counters are exposed as live gauges", async () => {
    const guideSamples = { counters: { captured: 4, skipped: 2, failed: 1, dropped: 0 } };
    const app = buildApp({ guideSamples });
    const res = await request(app)
      .get("/metrics")
      .set("authorization", "Bearer scrape-token");
    expect(res.status).toBe(200);
    expect(res.text).toContain("sc2tools_guide_samples_captured 4");
    expect(res.text).toContain("sc2tools_guide_samples_skipped 2");
    expect(res.text).toContain("sc2tools_guide_samples_failed 1");
    expect(res.text).toContain("sc2tools_guide_samples_dropped 0");
    guideSamples.counters.captured = 5;
    const res2 = await request(app)
      .get("/metrics")
      .set("authorization", "Bearer scrape-token");
    expect(res2.text).toContain("sc2tools_guide_samples_captured 5");
  });
});
