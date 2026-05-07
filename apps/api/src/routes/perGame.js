"use strict";

const express = require("express");

/**
 * /v1/games/:gameId/{build-order,apm-curve,macro-breakdown,
 *                    opp-build-order} — per-game compute & writebacks.
 *
 * GETs read whatever's stored in the game document (the agent uploaded
 * the data alongside the game). POSTs accept the agent's recomputed
 * payload (used by /macro/backfill flows and the SPA's "Recompute"
 * buttons) and persist it.
 *
 * @param {{
 *   perGame: import('../services/types').PerGameComputeService,
 *   auth: import('express').RequestHandler,
 *   io?: import('socket.io').Server,
 * }} deps
 */
function buildPerGameRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/games/:gameId/build-order", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const out = await deps.perGame.buildOrder(userId, String(req.params.gameId));
      if (!out) {
        res.status(404).json({ error: { code: "game_not_found" } });
        return;
      }
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  router.get("/games/:gameId/apm-curve", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const out = /** @type {any} */ (
        await deps.perGame.apmCurve(userId, String(req.params.gameId))
      );
      if (!out) {
        res.status(404).json({ error: { code: "game_not_found" } });
        return;
      }
      if (out.ok === false && out.code === "not_computed") {
        res
          .status(404)
          .json({ error: { code: "apm_not_computed" } });
        return;
      }
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  router.post("/games/:gameId/apm-curve", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      await deps.perGame.writeApmCurve(
        userId,
        String(req.params.gameId),
        req.body || {},
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/games/:gameId/macro-breakdown", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const out = /** @type {any} */ (
        await deps.perGame.macroBreakdown(userId, String(req.params.gameId))
      );
      if (!out) {
        res.status(404).json({ error: { code: "game_not_found" } });
        return;
      }
      if (out.ok === false && out.code === "not_computed") {
        res
          .status(404)
          .json({ error: { code: "macro_not_computed" } });
        return;
      }
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  // POST asks the agent to recompute. Body is OPTIONAL — if a body
  // payload is present we treat the call as the agent re-uploading.
  router.post("/games/:gameId/macro-breakdown", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const gameId = String(req.params.gameId);
      const body = req.body || {};
      if (body && typeof body.macroScore === "number") {
        await deps.perGame.writeMacroBreakdown(userId, gameId, {
          macroScore: body.macroScore,
          top3Leaks: body.top3Leaks,
          breakdown: body.breakdown || body,
        });
        res.status(202).json({ ok: true, persisted: true });
        return;
      }
      // No body — broadcast a recompute request to the user's agent.
      if (deps.io) {
        deps.io.to(`user:${userId}`).emit("macro:recompute_request", {
          gameIds: [gameId],
        });
      }
      res.status(202).json({ ok: true, requested: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/games/:gameId/opp-build-order", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const gameId = String(req.params.gameId);
      const body = req.body || {};
      if (Array.isArray(body.oppBuildLog)) {
        // ``oppEarlyBuildLog`` from the body is intentionally discarded:
        // since v0.4.3 it is derived from ``oppBuildLog`` at read time
        // (perGameCompute.readOppEarlyBuildLog), not stored. Older
        // agent payloads that still include the field round-trip
        // harmlessly — writeOpponentBuildOrder $unsets any stale value.
        await deps.perGame.writeOpponentBuildOrder(userId, gameId, {
          oppBuildLog: body.oppBuildLog,
        });
        res.status(202).json({ ok: true, persisted: true });
        return;
      }
      if (deps.io) {
        deps.io.to(`user:${userId}`).emit("opp_build_order:recompute_request", {
          gameId,
        });
      }
      res.status(202).json({ ok: true, requested: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * /v1/macro/backfill — bulk macro recompute (relays to the agent).
 *
 * @param {{
 *   macroBackfill: import('../services/types').MacroBackfillService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildMacroBackfillRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.post("/macro/backfill/start", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const body = req.body || {};
      const out = await deps.macroBackfill.start(userId, {
        limit: body.limit,
        force: !!body.force,
      });
      res.status(202).json({ ok: true, ...out });
    } catch (err) {
      next(err);
    }
  });

  router.get("/macro/backfill/status", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      let jobId = req.query.jobId ? String(req.query.jobId) : null;
      if (!jobId) {
        const latest = /** @type {any[]} */ (await deps.macroBackfill.latest(userId));
        jobId = latest[0]?.jobId || null;
      }
      if (!jobId) {
        res.json({ ok: true, running: false });
        return;
      }
      const status = await deps.macroBackfill.status(userId, jobId);
      if (!status) {
        res.status(404).json({ error: { code: "job_not_found" } });
        return;
      }
      res.json({ ok: true, ...status });
    } catch (err) {
      next(err);
    }
  });

  router.post("/macro/backfill/progress", async (req, res, next) => {
    try {
      // Only the agent reports progress — auth is shared with the
      // device-token middleware so this is safe to expose.
      const userId = requireAuth(req).userId;
      const body = req.body || {};
      if (!body.jobId || !body.gameId) {
        res.status(400).json({ error: { code: "jobId_and_gameId_required" } });
        return;
      }
      await deps.macroBackfill.reportProgress(userId, String(body.jobId), {
        gameId: String(body.gameId),
        ok: !!body.ok,
        message: body.message,
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {import('express').Request} req */
function requireAuth(req) {
  if (!req.auth) {
    const err = new Error("auth_required");
    /** @type {any} */ (err).status = 401;
    throw err;
  }
  return req.auth;
}

module.exports = { buildPerGameRouter, buildMacroBackfillRouter };
