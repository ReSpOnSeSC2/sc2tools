"use strict";

const express = require("express");

const DISCOVER_CACHE_TTL_MS = 60 * 1000;
const APPLY_CANDIDATE_CAP = 50;

/**
 * /v1/auto-classify — discovery-engine surface.
 *
 * Two endpoints share one router:
 *
 *   GET  /v1/auto-classify/candidates  → AutoClassifyService.discover
 *   POST /v1/auto-classify/apply       → AutoClassifyService.apply
 *
 * Discovery is read-only — it never writes to Mongo. ``apply`` is the
 * promotion path: it upserts each candidate through CustomBuildsService
 * (same (userId, slug) keyspace as hand-authored builds) and then runs
 * one global reclassify so the closest-match ownership rule lands.
 *
 * Why both routes live under the same router: they share the same
 * 60s in-process cache keyed by ``latestGameDateMs`` so a fresh upload
 * blows the candidates list without waiting for the TTL, and ``apply``
 * busts that cache as a side effect (a newly-applied build means the
 * formerly-unclassified games it now claims will be excluded from the
 * next discover() scan).
 *
 * @param {{
 *   autoClassify: import('../services/autoClassify').AutoClassifyService,
 *   customBuilds: import('../services/types').CustomBuildsService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildAutoClassifyRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  // In-process cache for the discovery payload. Keyed on
  // (userId, perspective, latestGameDateMs) so a fresh upload blows
  // the cached value without waiting for the TTL. Mirrors the pattern
  // the customBuilds router uses for compositions / transitions.
  /** @type {Map<string, {expires: number, value: any}>} */
  const discoverCache = new Map();
  function discoverCacheKey(userId, perspective, latestGameMs) {
    return `${userId}|${perspective}|${latestGameMs}`;
  }
  function discoverCacheGet(key) {
    const hit = discoverCache.get(key);
    if (!hit) return null;
    if (hit.expires <= Date.now()) {
      discoverCache.delete(key);
      return null;
    }
    return hit.value;
  }
  function discoverCacheSet(key, value) {
    discoverCache.set(key, {
      value,
      expires: Date.now() + DISCOVER_CACHE_TTL_MS,
    });
  }
  function discoverCacheBust(userId) {
    const prefix = `${userId}|`;
    for (const key of discoverCache.keys()) {
      if (key.startsWith(prefix)) discoverCache.delete(key);
    }
  }

  /**
   * GET /v1/auto-classify/candidates
   *
   * Query:
   *   perspective=you|opponent  (default: you)
   *
   * Returns the dry-run candidate list — never writes to Mongo. Cached
   * for 60s per (userId, perspective, latestGameDateMs). The
   * latestGameDateMs probe ensures a fresh upload invalidates the cache
   * key without waiting for the TTL.
   */
  router.get("/auto-classify/candidates", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.autoClassify || !deps.customBuilds) {
        res.status(503).json({ error: { code: "auto_classify_unavailable" } });
        return;
      }
      const perspective = pickPerspective(req.query && req.query.perspective);
      const latest = await deps.customBuilds.latestGameDateMs(auth.userId);
      const key = discoverCacheKey(auth.userId, perspective, latest);
      const cached = discoverCacheGet(key);
      if (cached) {
        res.json(cached);
        return;
      }
      const candidates = await deps.autoClassify.discover(auth.userId, {
        perspective,
      });
      const payload = { perspective, candidates };
      discoverCacheSet(key, payload);
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /v1/auto-classify/apply
   *
   * Body: { candidates: DiscoveryCandidate[] }  (max 50 per call)
   *
   * Validates the body shape, then hands off to
   * AutoClassifyService.apply for the upsert + reclassify pass. Returns
   * the service's summary verbatim so the UI can show
   * "Created N builds, tagged M games."
   *
   * 400 paths:
   *   - body.candidates not an array
   *   - body.candidates empty
   *   - body.candidates.length > 50
   *   - any candidate fails customBuild validation (the service throws
   *     with a structured ``details`` payload; we surface it verbatim).
   */
  router.post("/auto-classify/apply", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.autoClassify) {
        res.status(503).json({ error: { code: "auto_classify_unavailable" } });
        return;
      }
      const body = req.body || {};
      if (!Array.isArray(body.candidates)) {
        res.status(400).json({
          error: {
            code: "bad_request",
            details: ["candidates must be an array"],
          },
        });
        return;
      }
      if (body.candidates.length === 0) {
        res.status(400).json({
          error: {
            code: "bad_request",
            details: ["candidates required"],
          },
        });
        return;
      }
      if (body.candidates.length > APPLY_CANDIDATE_CAP) {
        res.status(400).json({
          error: {
            code: "bad_request",
            details: [`candidates max ${APPLY_CANDIDATE_CAP} per call`],
          },
        });
        return;
      }
      let result;
      try {
        result = await deps.autoClassify.apply(auth.userId, body.candidates);
      } catch (e) {
        const status = /** @type {any} */ (e).status;
        if (status === 400) {
          res.status(400).json({
            error: {
              code: /** @type {any} */ (e).message || "invalid_candidates",
              details: /** @type {any} */ (e).details || undefined,
            },
          });
          return;
        }
        throw e;
      }
      // Promotion produces fresh customBuilds rows + re-tagged games —
      // the formerly-unclassified games now belong to a real build, so
      // the next discover() scan must NOT serve a stale cached list.
      discoverCacheBust(auth.userId);
      res.status(200).json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Coerce a query-string ``perspective`` value into the union the
 * service expects, defaulting to ``you`` (the user's own opening) when
 * the value is missing or unknown.
 *
 * @param {unknown} raw
 * @returns {"you"|"opponent"}
 */
function pickPerspective(raw) {
  if (raw === "opponent") return "opponent";
  return "you";
}

module.exports = { buildAutoClassifyRouter };
