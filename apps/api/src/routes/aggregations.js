"use strict";

const express = require("express");
const { parseFilters, parseFiniteInt } = require("../util/parseQuery");

/**
 * /v1 — analytics aggregations.
 *
 * @param {{
 *   aggregations: import('../services/types').AggregationsService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildAggregationsRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/summary", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.aggregations.summary(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  router.get("/matchups", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.aggregations.matchups(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  router.get("/maps", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.aggregations.maps(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  // Diagnostic — every distinct raw `map` value the agent uploaded for
  // this user, ignoring the filter bar. Used by the BattlefieldTab
  // "Map diagnostic" disclosure when the headline panel shows a single
  // map and the user wants to see whether the data is really one map
  // or whether something downstream is collapsing them.
  router.get("/maps/diagnostic", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.json(await deps.aggregations.mapsDiagnostic(userId));
    } catch (err) {
      next(err);
    }
  });

  router.get("/build-vs-strategy", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.aggregations.buildVsStrategy(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  router.get("/random-summary", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      res.json(await deps.aggregations.randomSummary(userId, filters));
    } catch (err) {
      next(err);
    }
  });

  router.get("/timeseries", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const intervalRaw = String(req.query.interval || "day").toLowerCase();
      /** @type {'day' | 'week' | 'month'} */
      const interval =
        intervalRaw === "week" || intervalRaw === "month"
          ? intervalRaw
          : "day";
      res.json(
        await deps.aggregations.timeseries(userId, { interval }, filters),
      );
    } catch (err) {
      next(err);
    }
  });

  // The legacy /games endpoint that powered the Map Intel selector
  // (full filterable list, not the paginated cloud /games surface).
  router.get("/games-list", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const filters = parseFilters(req.query);
      const search =
        typeof req.query.search === "string" ? req.query.search : "";
      const sort =
        typeof req.query.sort === "string" ? req.query.sort : "date_desc";
      const limit = parseFiniteInt(req.query.limit);
      const offset = parseFiniteInt(req.query.offset);
      const resultBucket = pickResultBucket(req.query.result);
      res.json(
        await deps.aggregations.gamesList(userId, filters, {
          search,
          sort,
          limit,
          offset,
          resultBucket,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {import('express').Request} req */
function requireAuth(req) {
  if (!req.auth) throw httpError(401, "auth_required");
  return req.auth;
}

/** @param {unknown} raw @returns {'win' | 'loss' | undefined} */
function pickResultBucket(raw) {
  const s = String(raw || "").toLowerCase();
  if (s === "win" || s === "loss") return s;
  return undefined;
}

/** @param {number} status @param {string} code */
function httpError(status, code) {
  const err = new Error(code);
  /** @type {any} */ (err).status = status;
  /** @type {any} */ (err).code = code;
  return err;
}

module.exports = { buildAggregationsRouter };
