"use strict";

const express = require("express");
const { getPlaybackJob, startPlaybackJob, updatePlaybackJob, bindPlaybackJobDevice } = require("../services/replayPlaybackJobs");
const {
  claimReplayIngestAdmission,
  releaseReplayIngestAdmission,
} = require("../middleware/replayIngestAdmission");

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
    if (!claimLargeWrite(res)) return;
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
    } finally {
      releaseReplayIngestAdmission(res);
    }
  });

  // Engine rebuilds use the owned game's local replay and the normal upload
  // pipeline. Job status keeps agent/runtime errors visible while polling.
  router.get("/games/:gameId/map-playback", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const out = /** @type {any} */ (
        await deps.perGame.mapPlayback(userId, String(req.params.gameId))
      );
      if (!out) {
        res.status(404).json({ error: { code: "game_not_found" } });
        return;
      }
      const rebuild = getPlaybackJob(userId, String(req.params.gameId));
      if (out.ok === false && out.code === "not_computed") {
        if (rebuild) {
          res.json({ ...out, rebuild });
          return;
        }
        res.status(404).json({ error: { code: "playback_not_computed" } });
        return;
      }
      res.json({ ...out, ...(rebuild ? { rebuild } : {}) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/games/:gameId/map-playback", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const gameId = String(req.params.gameId);
      // mapPlayback scopes its lookup by userId even when the detail is absent.
      if (!await deps.perGame.mapPlayback(userId, gameId)) {
        res.status(404).json({ error: { code: "game_not_found" } });
        return;
      }
      const sockets = deps.io ? await deps.io.in(`user:${userId}`).fetchSockets() : [];
      const devices = sockets.filter(socket => socket.data?.kind === "device");
      if (!devices.length) {
        res.status(503).json({ error: { code: "agent_offline", message: "Open the SC2 Tools desktop agent on the computer containing this replay, then retry." } });
        return;
      }
      const pending = getPlaybackJob(userId, gameId);
      if (pending?.deviceId && ["queued", "processing", "uploading"].includes(pending.status) &&
          !devices.some(socket => socket.id === pending.deviceId)) {
        updatePlaybackJob(userId, gameId, pending.requestId, {
          status: "failed", code: "agent_disconnected", message: "The desktop agent disconnected during this rebuild. Retry with the agent open.",
        });
      }
      const { job, existing } = startPlaybackJob(userId, gameId);
      if (existing) {
        res.status(202).json({ ok: true, requested: true, rebuild: job });
        return;
      }
      let failure = { code: "agent_update_required", message: "Update and restart the desktop agent to rebuild this replay." };
      // Try one device at a time: only the computer holding this replay
      // should start a game engine process, even with several devices paired.
      for (const socket of devices.slice(0, 4)) {
        if (!bindPlaybackJobDevice(userId, gameId, job.requestId, socket.id)) break;
        try {
          const ack = await socket.timeout(5000).emitWithAck("macro:recompute_request", {
            gameIds: [gameId], replayFidelity: "engine", requestId: job.requestId,
          });
          if (ack?.requestId !== job.requestId || ack?.gameId !== gameId) break;
          if (ack.ok === true) {
            res.status(202).json({ ok: true, requested: true, rebuild: getPlaybackJob(userId, gameId) });
            return;
          }
          if (ack?.code === "replay_not_found") failure = { code: ack.code, message: "The original replay file was not found on your connected desktop agent." };
          else if (ack?.code === "engine_busy") {
            failure = { code: ack.code, message: "The desktop agent is rebuilding another replay. Retry when it finishes." };
            break;
          } else break;
        } catch {
          // A lost ACK may still mean work started. Do not dispatch the same
          // replay to another machine when the first outcome is unknown.
          break;
        }
      }
      updatePlaybackJob(userId, gameId, job.requestId, { status: "failed", ...failure });
      res.status(failure.code === "replay_not_found" ? 409 : 503).json({ error: failure });
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
    if (!claimLargeWrite(res)) return;
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
    } finally {
      releaseReplayIngestAdmission(res);
    }
  });

  router.post("/games/:gameId/opp-build-order", async (req, res, next) => {
    if (!claimLargeWrite(res)) return;
    try {
      const userId = requireAuth(req).userId;
      const gameId = String(req.params.gameId);
      const body = req.body || {};
      if (Array.isArray(body.oppBuildLog)) {
        const controller = new AbortController();
        const onAborted = () => controller.abort();
        req.once("aborted", onAborted);
        res.once("close", onAborted);
        // ``oppEarlyBuildLog`` from the body is intentionally discarded:
        // since v0.4.3 it is derived from ``oppBuildLog`` at read time
        // (perGameCompute.readOppEarlyBuildLog), not stored. Older
        // agent payloads that still include the field round-trip
        // harmlessly — writeOpponentBuildOrder $unsets any stale value.
        try {
          await deps.perGame.writeOpponentBuildOrder(userId, gameId, {
            oppBuildLog: body.oppBuildLog,
          }, { signal: controller.signal });
        } catch (err) {
          if (
            err && typeof err === "object" && "code" in err
            && err.code === "opponent_build_order_busy"
          ) {
            const retryAfterSec = "retryAfterSec" in err
              ? Number(err.retryAfterSec) || 2
              : 2;
            res.set("Retry-After", String(retryAfterSec));
            res.status(503).json({
              error: { code: "opponent_build_order_busy", retryable: true },
            });
            return;
          }
          throw err;
        } finally {
          req.removeListener("aborted", onAborted);
          res.removeListener("close", onAborted);
        }
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
    } finally {
      releaseReplayIngestAdmission(res);
    }
  });

  return router;
}

/**
 * Claim the pre-parser large-body lane. Focused router unit tests mount this
 * router without the assembled app middleware, so they may proceed without a
 * lane; production fails closed when a claimed lane was already released.
 * @param {import('express').Response} res
 */
function claimLargeWrite(res) {
  const claimed = claimReplayIngestAdmission(res, { allowMissing: true });
  if (!claimed && !res.headersSent) {
    res.set("Retry-After", "5");
    res.status(503).json({
      error: { code: "replay_ingest_busy", retryable: true },
    });
  }
  return claimed;
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
        // Free-form telemetry tag — surfaces in the agent log
        // (`full_resync_running reason=…`) so a future "why did the
        // agent resync?" investigation can identify the trigger.
        // Capped to a sane length to keep socket payloads small.
        reason:
          typeof body.reason === "string"
            ? body.reason.slice(0, 64)
            : undefined,
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
