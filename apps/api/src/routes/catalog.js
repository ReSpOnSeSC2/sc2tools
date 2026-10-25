"use strict";

const express = require("express");
const { parseFilters } = require("../util/parseQuery");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");

/**
 * /v1/catalog, /v1/definitions, /v1/export.csv, /v1/playback —
 * static + per-user export routes. /v1/map-image lives in its own
 * public router (see routes/mapImage.js) because <img> tags can't
 * attach an Authorization header.
 *
 * @param {{
 *   catalog: import('../services/types').CatalogService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildCatalogRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);
  const exportLimiter = (rateLimitModule.default || rateLimitModule)({ windowMs: 60_000, max: 1, standardHeaders: true, legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }),
    keyGenerator: req => `replay-csv:${req.auth?.userId || req.ip}`,
    message: { error: { code: "export_rate_limited", message: "You can export once per minute. Please wait and try again." } },
  });

  router.get("/catalog", async (_req, res, next) => {
    try {
      res.json(await deps.catalog.catalog());
    } catch (err) {
      next(err);
    }
  });

  router.get("/definitions", async (_req, res, next) => {
    try {
      res.json(await deps.catalog.definitions());
    } catch (err) {
      next(err);
    }
  });

  router.get("/export.csv", exportLimiter, async (req, res, next) => {
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    res.once("close", disconnected);
    try {
      const userId = requireAuth(req).userId;
      const prepared = await deps.catalog.prepareCsv(userId, parseFilters(req.query), { search: req.query.search, result: req.query.result, matchup: req.query.matchup, sort: req.query.sort, signal: controller.signal });
      res.set("Cache-Control", "private, no-store");
      res.set("X-Export-Truncated", String(prepared.truncated));
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader(
        "content-disposition",
        `attachment; filename="sc2tools-export-${new Date()
          .toISOString()
          .slice(0, 10)}.csv"`,
      );
      for await (const chunk of prepared.stream) {
        if (res.destroyed) break;
        if (!res.write(chunk)) {
          await new Promise((resolve) => {
            const ready = () => { res.off("drain", ready); res.off("close", ready); resolve(undefined); };
            res.once("drain", ready); res.once("close", ready);
          });
        }
      }
      if (!res.destroyed) res.end();
    } catch (err) {
      if (!res.destroyed) next(err);
    } finally { res.off("close", disconnected); controller.abort(); }
  });

  router.get("/playback", (req, res, next) => {
    try {
      requireAuth(req);
      res.status(501).json(deps.catalog.playbackInfo());
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

module.exports = { buildCatalogRouter };
