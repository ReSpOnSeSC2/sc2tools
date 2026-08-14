"use strict";

const express = require("express");
const { parseFilters } = require("../util/parseQuery");

const PHASE_CACHE_TTL_MS = 60 * 1000;
const PHASE_CACHE_MAX_ENTRIES = 32;
const PHASE_MAX_CONCURRENT = 1;
const PHASE_MAX_WAITERS = 8;
const PHASE_MAX_SUBSCRIBERS = 32;
const PHASE_RETRY_AFTER_SEC = 2;
const PHASE_BUSY = Symbol("phase_busy");
const PHASE_CANCELLED = Symbol("phase_cancelled");

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
  /**
   * @param {string} kind
   * @param {string} userId
   * @param {string} name
   * @param {number} latestGameMs
   * @param {string} perspective
   * @param {string} crossAxis
   * @param {string} filtersKey
   */
  function phaseCacheKey(kind, userId, name, latestGameMs, perspective, crossAxis, filtersKey) {
    // ``crossAxis`` is the OTHER coordinate of the build × strategy
    // cell the BuildVsStrategyComparison drill-down passes through —
    // including it in the cache key keeps the cell-scoped payload
    // from colliding with the unfiltered "all games with this label"
    // payload BuildDossier-style callers still ask for.
    //
    // ``filtersKey`` serialises the global filter bar (timeframe / race
    // / map / mmr / region / excludeTooShort) so two requests that
    // differ only in the filter bar don't alias to the same cached
    // entry — the matched-set is filter-dependent.
    return `${kind}|${userId}|${name}|${latestGameMs}|${perspective}|${crossAxis || ""}|${filtersKey || ""}`;
  }
  /**
   * Stable string key for a parsed filter object. Sorted entries so two
   * URLs with the same filters in a different order share a cache slot.
   * Dates serialise to ms so the value is a single primitive per key.
   *
   * @param {Record<string, any>} filters
   * @returns {string}
   */
  function filtersCacheKey(filters) {
    if (!filters) return "";
    const entries = Object.entries(filters)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => {
        if (v instanceof Date) return [k, v.getTime()];
        if (Array.isArray(v)) return [k, v.slice().sort().join(",")];
        return [k, v];
      })
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return entries.map(([k, v]) => `${k}=${v}`).join("&");
  }
  /** @param {string} key */
  function phaseCacheGet(key) {
    const hit = phaseCache.get(key);
    if (!hit) return null;
    if (hit.expires <= Date.now()) {
      phaseCache.delete(key);
      return null;
    }
    phaseCache.delete(key);
    phaseCache.set(key, hit);
    return hit.value;
  }
  /** @param {string} key @param {unknown} value */
  function phaseCacheSet(key, value) {
    const now = Date.now();
    for (const [cachedKey, entry] of phaseCache) {
      if (entry.expires <= now) phaseCache.delete(cachedKey);
    }
    phaseCache.delete(key);
    phaseCache.set(key, { value, expires: now + PHASE_CACHE_TTL_MS });
    while (phaseCache.size > PHASE_CACHE_MAX_ENTRIES) {
      const oldest = phaseCache.keys().next().value;
      if (oldest === undefined) break;
      phaseCache.delete(oldest);
    }
  }

  /** @type {Map<string, {controller: AbortController, promise: Promise<any>, subscribers: number, settled: boolean}>} */
  const phaseInFlight = new Map();
  let activePhaseComputations = 0;
  /** @type {Array<{signal: AbortSignal, resolve: (release: (() => void)|null) => void}>} */
  const phaseWaiters = [];

  /** @param {AbortSignal} signal @returns {Promise<(() => void)|null>} */
  function acquirePhaseSlot(signal) {
    if (signal.aborted) return Promise.resolve(null);
    if (activePhaseComputations < PHASE_MAX_CONCURRENT) {
      activePhaseComputations += 1;
      return Promise.resolve(releasePhaseSlot);
    }
    if (phaseWaiters.length >= PHASE_MAX_WAITERS) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      /** @type {() => void} */
      let onAbort = () => {};
      /** @param {(() => void)|null} release */
      const finish = (release) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(release);
      };
      const waiter = { signal, resolve: finish };
      onAbort = () => {
        const index = phaseWaiters.indexOf(waiter);
        if (index >= 0) phaseWaiters.splice(index, 1);
        finish(null);
      };
      phaseWaiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  function releasePhaseSlot() {
    activePhaseComputations = Math.max(0, activePhaseComputations - 1);
    while (phaseWaiters.length > 0) {
      const waiter = phaseWaiters.shift();
      if (!waiter || waiter.signal.aborted) continue;
      activePhaseComputations += 1;
      waiter.resolve(releasePhaseSlot);
      break;
    }
  }

  /**
   * Coalesce identical analysis while serialising distinct heavy scans. A
   * bounded waiter/subscriber count prevents retained HTTP handlers from
   * becoming a second memory multiplier around an otherwise bounded scan.
   * @param {string} key
   * @param {(signal: AbortSignal) => Promise<any>} compute
   * @param {AbortSignal} subscriberSignal
   */
  async function runPhaseComputation(key, compute, subscriberSignal) {
    if (subscriberSignal.aborted) return PHASE_CANCELLED;
    let entry = phaseInFlight.get(key);
    if (entry && entry.controller.signal.aborted && !entry.settled) {
      if (phaseInFlight.get(key) === entry) phaseInFlight.delete(key);
      entry = undefined;
    }
    if (!entry) {
      const controller = new AbortController();
      entry = {
        controller,
        promise: Promise.resolve(PHASE_CANCELLED),
        subscribers: 0,
        settled: false,
      };
      entry.promise = (async () => {
        const release = await acquirePhaseSlot(controller.signal);
        if (!release) {
          return controller.signal.aborted ? PHASE_CANCELLED : PHASE_BUSY;
        }
        try {
          const value = await compute(controller.signal);
          return controller.signal.aborted ? PHASE_CANCELLED : value;
        } catch (error) {
          if (controller.signal.aborted) return PHASE_CANCELLED;
          throw error;
        } finally {
          release();
        }
      })();
      phaseInFlight.set(key, entry);
      const created = entry;
      const settle = () => {
        created.settled = true;
        if (phaseInFlight.get(key) === created) phaseInFlight.delete(key);
      };
      void entry.promise.then(settle, settle);
    }
    if (entry.subscribers >= PHASE_MAX_SUBSCRIBERS) return PHASE_BUSY;
    entry.subscribers += 1;
    /** @type {() => void} */
    let onAbort = () => {};
    const disconnected = new Promise((resolve) => {
      onAbort = () => resolve(PHASE_CANCELLED);
      subscriberSignal.addEventListener("abort", onAbort, { once: true });
      if (subscriberSignal.aborted) onAbort();
    });
    try {
      return await Promise.race([entry.promise, disconnected]);
    } finally {
      subscriberSignal.removeEventListener("abort", onAbort);
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      if (entry.subscribers === 0 && !entry.settled) entry.controller.abort();
    }
  }

  /** @param {import('express').Request} req @param {import('express').Response} res */
  function phaseRequestAbort(req, res) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => {
      if (!res.writableEnded) abort();
    };
    req.once("aborted", abort);
    res.once("close", close);
    return {
      signal: controller.signal,
      cleanup() {
        req.removeListener("aborted", abort);
        res.removeListener("close", close);
      },
    };
  }

  /** @param {import('express').Response} res @param {AbortSignal} signal @param {any} value */
  function handlePhaseAdmissionResult(res, signal, value) {
    if (value === PHASE_BUSY) {
      res.set("Retry-After", String(PHASE_RETRY_AFTER_SEC));
      res.status(503).json({ error: { code: "phase_analysis_busy" } });
      return true;
    }
    if (value === PHASE_CANCELLED) {
      if (!signal.aborted && !res.headersSent) {
        res.set("Retry-After", String(PHASE_RETRY_AFTER_SEC));
        res.status(503).json({ error: { code: "phase_analysis_retry" } });
      }
      return true;
    }
    return false;
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
      const strategyPhases = deps.strategyPhases;
      if (!strategyPhases) {
        res.status(503).json({ error: { code: "stats_unavailable" } });
        return;
      }
      const requestScope = phaseRequestAbort(req, res);
      try {
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
      const filters = parseFilters(req.query);
      const latest = await strategyPhases.latestGameDateMs(userId);
      const key = phaseCacheKey(
        "strategy",
        userId,
        name,
        latest,
        perspective,
        buildName ? `b:${buildName}` : "",
        filtersCacheKey(filters),
      );
      const cached = phaseCacheGet(key);
      if (cached) {
        res.json(cached);
        return;
      }
      const result = await runPhaseComputation(
        key,
        (signal) => strategyPhases.evaluate(userId, name, {
          perspective,
          buildName,
          filters,
          signal,
        }),
        requestScope.signal,
      );
      if (handlePhaseAdmissionResult(res, requestScope.signal, result)) return;
      if (!result) {
        res.status(404).json({ error: { code: "strategy_not_found" } });
        return;
      }
      phaseCacheSet(key, result);
      res.json(result);
      } finally {
        requestScope.cleanup();
      }
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
      const strategyPhases = deps.strategyPhases;
      if (!strategyPhases) {
        res.status(503).json({ error: { code: "stats_unavailable" } });
        return;
      }
      const requestScope = phaseRequestAbort(req, res);
      try {
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
      const filters = parseFilters(req.query);
      const latest = await strategyPhases.latestGameDateMs(userId);
      const key = phaseCacheKey(
        "build",
        userId,
        name,
        latest,
        perspective,
        strategyName ? `s:${strategyName}` : "",
        filtersCacheKey(filters),
      );
      const cached = phaseCacheGet(key);
      if (cached) {
        res.json(cached);
        return;
      }
      const result = await runPhaseComputation(
        key,
        (signal) => strategyPhases.evaluateByBuildName(
          userId,
          name,
          { perspective, strategyName, filters, signal },
        ),
        requestScope.signal,
      );
      if (handlePhaseAdmissionResult(res, requestScope.signal, result)) return;
      if (!result) {
        res.status(404).json({ error: { code: "build_not_found" } });
        return;
      }
      phaseCacheSet(key, result);
      res.json(result);
      } finally {
        requestScope.cleanup();
      }
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
