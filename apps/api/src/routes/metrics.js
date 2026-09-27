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
 * Guide sample capture (services/guideSamples.js) exposes its
 * captured/skipped/failed/dropped tallies the same way, as
 * ``sc2tools_guide_samples_<counter>`` gauges.
 *
 * @param {{
 *   token: string,
 *   liveGameBroker?: { counters: Record<string, number> },
 *   guideSamples?: { counters: Record<string, number> },
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
    // Broker counters are monotonic per-process tallies — expose as
    // gauges read at scrape time so we never have to keep the two
    // counting systems in sync.
    registerCounterGauges(promClient, registry, deps.liveGameBroker, {
      prefix: "sc2tools_live_broker_",
      help: "LiveGameBroker counter",
    });
  }
  if (deps.guideSamples) {
    registerCounterGauges(promClient, registry, deps.guideSamples, {
      prefix: "sc2tools_guide_samples_",
      help: "Guide sample capture counter",
    });
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

/**
 * One gauge per key of ``source.counters``, read live at scrape time.
 *
 * @param {typeof import('prom-client')} promClient
 * @param {import('prom-client').Registry} registry
 * @param {{ counters: Record<string, number> }} source
 * @param {{ prefix: string, help: string }} naming
 */
function registerCounterGauges(promClient, registry, source, naming) {
  for (const name of Object.keys(source.counters || {})) {
    const gauge = new promClient.Gauge({
      name: `${naming.prefix}${name}`,
      help: `${naming.help}: ${name}`,
      registers: [registry],
      collect() {
        this.set(source.counters[name] || 0);
      },
    });
    void gauge;
  }
}

module.exports = { buildMetricsRouter };
