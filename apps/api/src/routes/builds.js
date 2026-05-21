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
  // (kind, userId, name, latestGameDate, perspective) turns a back-
  // and-forth flip between strategy drill-downs into a single Mongo
  // scan. ``kind`` prefixes prevent a collision between a strategy
  // and a build label that happen to share the same string. Mirrors
  // the cache shape in routes/customBuilds.js so both phase
  // endpoints behave the same way after a fresh upload.
  /** @type {Map<string, {expires: number, value: any}>} */
  const phaseCache = new Map();
  function phaseCacheKey(kind, userId, name, latestGameMs, perspective, crossAxis) {
    // ``crossAxis`` is the OTHER coordinate of the build × strategy
    // cell the BuildVsStrategyComparison drill-down passes through —
    // including it in the cache key keeps the cell-scoped payload
    // from colliding with the unfiltered "all games with this label"
    // payload BuildDossier-style callers still ask for.
    return `${kind}|${userId}|${name}|${latestGameMs}|${perspective}|${crossAxis || ""}`;
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
      const perspective = req.query && req.query.perspective === "opponent"
        ? "opponent"
        : "you";
      // Optional ``build`` query param scopes the strategy aggregation
      // to one cell of the build × strategy matrix — the drill-down
      // passes it through so the right column of the comparison view
      // describes the SAME game set as the cell the user clicked.
      const buildName =
        req.query && typeof req.query.build === "string" && req.query.build
          ? String(req.query.build)
          : null;
      const latest = await deps.strategyPhases.latestGameDateMs(userId);
      const key = phaseCacheKey(
        "strategy",
        userId,
        name,
        latest,
        perspective,
        buildName ? `b:${buildName}` : "",
      );
      const cached = phaseCacheGet(key);
      if (cached) {
        res.json(cached);
        return;
      }
      const result = await deps.strategyPhases.evaluate(userId, name, {
        perspective,
        buildName,
      });
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

  /**
   * GET /v1/builds/:name/phases
   *
   * Phase-aware aggregator keyed by the user-side build label
   * (``g.myBuild``). The left column of the StrategiesTab build ×
   * strategy drill-down ("WHAT YOU TYPICALLY DO") consumes this when
   * the agent's auto-classified label doesn't map to a saved custom
   * build, so the user still sees their typical pattern from the
   * games already tagged with that label. Same envelope as
   * ``/v1/strategies/:name/phases`` — the SPA can pass either
   * straight to PhaseTrajectoryStrip / PhaseCompositionTabs.
   */
  router.get("/builds/:name/phases", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      if (!deps.strategyPhases) {
        res.status(503).json({ error: { code: "stats_unavailable" } });
        return;
      }
      const name = String(req.params.name || "");
      const perspective =
        req.query && req.query.perspective === "opponent"
          ? "opponent"
          : "you";
      // Optional ``strategy`` query param scopes the build aggregation
      // to one cell of the build × strategy matrix — the drill-down
      // passes it through so the left column of the comparison view
      // describes the SAME game set as the cell the user clicked.
      const strategyName =
        req.query && typeof req.query.strategy === "string" && req.query.strategy
          ? String(req.query.strategy)
          : null;
      const latest = await deps.strategyPhases.latestGameDateMs(userId);
      const key = phaseCacheKey(
        "build",
        userId,
        name,
        latest,
        perspective,
        strategyName ? `s:${strategyName}` : "",
      );
      const cached = phaseCacheGet(key);
      if (cached) {
        res.json(cached);
        return;
      }
      const result = await deps.strategyPhases.evaluateByBuildName(
        userId,
        name,
        { perspective, strategyName },
      );
      if (!result) {
        res.status(404).json({ error: { code: "build_not_found" } });
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
