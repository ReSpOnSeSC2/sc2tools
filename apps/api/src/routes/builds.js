"use strict";

const express = require("express");
const { parseFilters } = require("../util/parseQuery");

const PHASE_CACHE_TTL_MS = 60 * 1000;

/**
 * /v1/builds, /v1/opp-strategies, /v1/strategies/:name/phases —
 * analytics over the user's build library and detected opponent
 * strategies.
 *
 * @param {{
 *   builds: import('../services/types').BuildsService,
 *   strategyPhases?: import('../services/types').StrategyPhasesService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildBuildsRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  // In-process cache for the strategy phase-aware payload. Each
  // request re-scans up to STATS_GAME_SCAN_CAP games with the
  // ``macroBreakdown`` blob; a tight 60s TTL keyed on
  // (userId, name, latestGameDate) turns a back-and-forth flip
  // between strategy drill-downs into a single Mongo scan. Mirrors
  // the cache shape in routes/customBuilds.js so both phase
  // endpoints behave the same way after a fresh upload.
  /** @type {Map<string, {expires: number, value: any}>} */
  const phaseCache = new Map();
  function phaseCacheKey(userId, name, latestGameMs) {
    return `${userId}|${name}|${latestGameMs}`;
  }
  function phaseCacheGet(key) {
    const hit = phaseCache.get(key);
    if (!hit) return null;
    if (hit.expires <= Date.now()) {
      phaseCache.delete(key);
      return null;
    }
    return hit.value;
  }
  function phaseCacheSet(key, value) {
    phaseCache.set(key, { value, expires: Date.now() + PHASE_CACHE_TTL_MS });
  }

  router.get("/builds", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.json(await deps.builds.list(userId, parseFilters(req.query)));
    } catch (err) {
      next(err);
    }
  });

  router.get("/builds/:name", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const name = String(req.params.name || "");
      const detail = await deps.builds.detail(
        userId,
        name,
        parseFilters(req.query),
      );
      if (!detail) {
        res.status(404).json({ error: { code: "build_not_found" } });
        return;
      }
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  router.get("/opp-strategies", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.json(
        await deps.builds.oppStrategies(userId, parseFilters(req.query)),
      );
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /v1/strategies/:name/phases
   *
   * Phase-aware aggregator keyed by opponent strategy. Returns the
   * same envelope shape ``/v1/custom-builds/:slug/compositions``
   * uses (sampleSize, perPhase, finalPhaseDistribution,
   * medianCrossings, durationP95Sec, flags) so the StrategiesTab
   * drill-down can reuse PhaseTrajectoryStrip + PhaseCompositionTabs
   * unchanged. ``transitions`` are intentionally omitted —
   * StrategiesTab is about "what they're doing", not your routing.
   */
  router.get("/strategies/:name/phases", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      if (!deps.strategyPhases) {
        res.status(503).json({ error: { code: "stats_unavailable" } });
        return;
      }
      const name = String(req.params.name || "");
      const latest = await deps.strategyPhases.latestGameDateMs(userId);
      const key = phaseCacheKey(userId, name, latest);
      const cached = phaseCacheGet(key);
      if (cached) {
        res.json(cached);
        return;
      }
      const result = await deps.strategyPhases.evaluate(userId, name);
      if (!result) {
        res.status(404).json({ error: { code: "strategy_not_found" } });
        return;
      }
      phaseCacheSet(key, result);
      res.json(result);
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

module.exports = { buildBuildsRouter };
