"use strict";

const express = require("express");
const { parseFilters, parseFiniteInt } = require("../util/parseQuery");

/** The longest opponent key the dossier routes accept. */
const MAX_OPPONENT_KEY = 200;

/**
 * /v1/spatial/{maps,buildings,proxy,battle,death-zone,opponent-proxies}
 *
 * The heatmap routes read only the caller's own games. ``opponent`` (a
 * dossier pulse id) narrows them to that opponent's games, resolved by the
 * same identity rules as the dossier's replay history; ``mergeLinked=1``
 * folds in every identity linked to the same player.
 *
 * @param {{
 *   spatial: import('../services/types').SpatialService,
 *   opponents?: { identityClause: (userId: string, pulseId: string, opts?: { mergeLinked?: boolean }) => Promise<Record<string, any> | null> },
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
        const opponent = await opponentClause(deps, userId, req.query);
        const handler = deps.spatial[method].bind(deps.spatial);
        res.set("Cache-Control", "private, no-store").json(
          await handler(userId, map, parseFilters(req.query), { grid, opponent }),
        );
      } catch (err) {
        next(err);
      }
    });
  }

  return router;
}

/**
 * The opponent filter, or null when the request has none.
 * @param {Parameters<typeof buildSpatialRouter>[0]} deps
 * @param {string} userId
 * @param {Record<string, unknown>} query
 */
async function opponentClause(deps, userId, query) {
  if (query.opponent === undefined) return null;
  const pulseId = typeof query.opponent === "string" ? query.opponent.trim() : "";
  if (!pulseId || pulseId.length > MAX_OPPONENT_KEY || /[\u0000-\u001f\u007f]/.test(pulseId)) {
    throw httpError(400, "invalid_opponent");
  }
  if (!deps.opponents) throw httpError(503, "opponents_unavailable");
  const clause = await deps.opponents.identityClause(userId, pulseId, {
    mergeLinked: query.mergeLinked === "1",
  });
  if (!clause) throw httpError(404, "not_found");
  return clause;
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

/** @param {number} status @param {string} code */
function httpError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

module.exports = { buildSpatialRouter };
