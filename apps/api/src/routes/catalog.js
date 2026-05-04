"use strict";

const express = require("express");
const fs = require("fs");
const { parseFilters } = require("../util/parseQuery");

/**
 * /v1/catalog, /v1/definitions, /v1/export.csv, /v1/map-image,
 * /v1/playback — static + per-user export routes.
 *
 * @param {{
 *   catalog: import('../services/types').CatalogService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildCatalogRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

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

  router.get("/export.csv", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader(
        "content-disposition",
        `attachment; filename="sc2tools-export-${new Date()
          .toISOString()
          .slice(0, 10)}.csv"`,
      );
      const filters = parseFilters(req.query);
      for await (const chunk of deps.catalog.exportCsv(userId, filters)) {
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/map-image", (req, res, next) => {
    try {
      requireAuth(req);
      const name = String(req.query.map || "").trim();
      if (!name) {
        res.status(400).json({ error: { code: "map_required" } });
        return;
      }
      const found = deps.catalog.mapImagePath(name);
      if (!found) {
        res.status(404).json({ error: { code: "map_image_not_found" } });
        return;
      }
      res.setHeader("content-type", found.contentType);
      res.setHeader("cache-control", "public, max-age=86400");
      fs.createReadStream(found.path)
        .on("error", (e) => next(e))
        .pipe(res);
    } catch (err) {
      next(err);
    }
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
