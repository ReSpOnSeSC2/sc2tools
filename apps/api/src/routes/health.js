"use strict";

const express = require("express");

/**
 * Health endpoints.
 *
 * /v1/health — unauth, pings Mongo so Render's healthCheck doesn't accept a
 *   server with a dead DB connection. Slightly more expensive (one round trip
 *   to Atlas), so reserved for orchestrator probes.
 *
 * /v1/ping — unauth, no DB hit, instant 200. Designed to be hammered by a
 *   keep-alive worker (internal or external) every 10–14 minutes to stop the
 *   Render starter instance from idling. Kept dirt cheap so monitoring
 *   traffic does not cost us a Mongo connection per request.
 *
 * @param {{db: {client: import('mongodb').MongoClient}}} deps
 * @returns {import('express').Router}
 */
function buildHealthRouter(deps) {
  const router = express.Router();
  router.get("/health", async (_req, res, next) => {
    try {
      await deps.db.client.db().admin().ping();
      res.json({ status: "ok", time: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });
  router.get("/ping", (_req, res) => {
    res.set("cache-control", "no-store");
    res.json({ status: "ok", time: new Date().toISOString() });
  });
  return router;
}

module.exports = { buildHealthRouter };
