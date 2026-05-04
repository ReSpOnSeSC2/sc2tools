"use strict";

const express = require("express");
const { parseFilters, parseFiniteInt } = require("../util/parseQuery");

/**
 * /v1/spatial/{maps,buildings,proxy,battle,death-zone,opponent-proxies}
 *
 * @param {{
 *   spatial: import('../services/types').SpatialService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildSpatialRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/spatial/maps", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.json(await deps.spatial.maps(userId, parseFilters(req.query)));
    } catch (err) {
      next(err);
    }
  });

  /** @type {Array<[string, 'buildings' | 'proxy' | 'battle' | 'deathZone' | 'opponentProxies']>} */
  const heatmapRoutes = [
    ["buildings", "buildings"],
    ["proxy", "proxy"],
    ["battle", "battle"],
    ["death-zone", "deathZone"],
    ["opponent-proxies", "opponentProxies"],
  ];
  for (const [routePath, method] of heatmapRoutes) {
    router.get(`/spatial/${routePath}`, async (req, res, next) => {
      try {
        const userId = requireAuth(req).userId;
        const map = String(req.query.map || "");
        if (!map) {
          res.status(400).json({ error: { code: "map_required" } });
          return;
        }
        const grid = parseFiniteInt(req.query.grid);
        const handler = deps.spatial[method].bind(deps.spatial);
        res.json(
          await handler(userId, map, parseFilters(req.query), { grid }),
        );
      } catch (err) {
        next(err);
      }
    });
  }

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

module.exports = { buildSpatialRouter };
