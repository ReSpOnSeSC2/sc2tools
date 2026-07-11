"use strict";

const express = require("express");

// The write probe upserts a single fixed doc into the jobLocks
// collection (already used for cron coordination, so no new
// collection). Cached so Render's frequent health polling — it uses
// /v1/health for BOTH liveness and the autoscaling probe — doesn't
// multiply Mongo writes.
const WRITE_PROBE_CACHE_MS = 10_000;

/**
 * Health endpoints.
 *
 * /v1/health — unauth. Verifies BOTH the read path (admin ping) and the
 *   write path (heartbeat upsert) so Render's healthCheck doesn't keep a
 *   server in rotation when the cluster is degraded — e.g. a replica set
 *   stuck read-only would previously ping fine while every ingest
 *   silently failed. Degradation returns 503 with a per-check breakdown
 *   (not a 500 through the error handler, which monitoring tools read
 *   as "app crashed" rather than "dependency degraded").
 *
 * /v1/ping — unauth, no DB hit, instant 200. Designed to be hammered by a
 *   keep-alive worker (internal or external) every 10–14 minutes to stop the
 *   Render starter instance from idling. Kept dirt cheap so monitoring
 *   traffic does not cost us a Mongo connection per request.
 *
 * @param {{db: {client: import('mongodb').MongoClient, db: import('mongodb').Db}}} deps
 * @returns {import('express').Router}
 */
function buildHealthRouter(deps) {
  const router = express.Router();

  /** @type {{ at: number, ok: boolean } | null} */
  let lastWriteProbe = null;

  async function probeWrite() {
    const now = Date.now();
    if (lastWriteProbe && now - lastWriteProbe.at < WRITE_PROBE_CACHE_MS) {
      return lastWriteProbe.ok;
    }
    try {
      await deps.db.db
        .collection("jobLocks")
        .updateOne(
          // jobLocks deliberately uses string _ids (see
          // pulseBackfillJob's lock doc); the driver's default
          // Document type pins _id to ObjectId, hence the cast.
          { _id: /** @type {any} */ ("healthcheck") },
          { $set: { ts: new Date() } },
          { upsert: true },
        );
      lastWriteProbe = { at: now, ok: true };
    } catch {
      lastWriteProbe = { at: now, ok: false };
    }
    return lastWriteProbe.ok;
  }

  router.get("/health", async (_req, res) => {
    const checks = { mongoPing: false, mongoWrite: false };
    try {
      await deps.db.client.db().admin().ping();
      checks.mongoPing = true;
    } catch {
      // fall through — reported via the 503 payload
    }
    // Skip the write probe when the read path is already down: the
    // extra round trip would just wait out a second driver timeout.
    if (checks.mongoPing) {
      checks.mongoWrite = await probeWrite();
    }
    const healthy = checks.mongoPing && checks.mongoWrite;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      checks,
      time: new Date().toISOString(),
    });
  });

  router.get("/ping", (_req, res) => {
    res.set("cache-control", "no-store");
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  return router;
}

module.exports = { buildHealthRouter };
