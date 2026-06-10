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

function buildApp({ broker } = {}) {
  const app = express();
  app.use(buildMetricsRouter({ token: "scrape-token", liveGameBroker: broker }));
  return app;
}

describe("GET /metrics", () => {
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
});
