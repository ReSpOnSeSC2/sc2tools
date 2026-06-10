"use strict";

const express = require("express");

/**
 * GET /v1/metrics — Prometheus exposition endpoint.
 *
 * prom-client has been a dependency since the first Render deploy but
 * was never wired to a route; the LiveGameBroker even kept counters
 * "for a metrics endpoint (later)". This is that endpoint: Node
 * process defaults plus the broker's live-overlay telemetry.
 *
 * Auth: a static bearer token (METRICS_TOKEN env). When the token is
 * unset the route is not mounted at all — safe-by-default, since the
 * metrics expose internal traffic shape. Prometheus/Grafana Cloud
 * scrape configs pass it via `authorization: Bearer <token>`.
 *
 * @param {{
 *   token: string,
 *   liveGameBroker?: { counters: Record<string, number> },
 * }} deps
 * @returns {import('express').Router}
 */
function buildMetricsRouter(deps) {
  const router = express.Router();
  // Lazy require keeps unit tests that import app.js (without the
  // token configured) from loading prom-client at all.
  const promClient = require("prom-client");
  const registry = new promClient.Registry();
  promClient.collectDefaultMetrics({ register: registry });

  if (deps.liveGameBroker) {
    const broker = deps.liveGameBroker;
    const counterNames = Object.keys(broker.counters || {});
    for (const name of counterNames) {
      // Broker counters are monotonic per-process tallies — expose as
      // gauges read at scrape time so we never have to keep the two
      // counting systems in sync.
      const gauge = new promClient.Gauge({
        name: `sc2tools_live_broker_${name}`,
        help: `LiveGameBroker counter: ${name}`,
        registers: [registry],
        collect() {
          this.set(broker.counters[name] || 0);
        },
      });
      void gauge;
    }
  }

  router.get("/metrics", async (req, res) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token || token !== deps.token) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return;
    }
    res.set("content-type", registry.contentType);
    res.send(await registry.metrics());
  });

  return router;
}

module.exports = { buildMetricsRouter };
