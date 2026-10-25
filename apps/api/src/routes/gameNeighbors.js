"use strict";

const { parseFilters } = require("../util/parseQuery");

/** @param {import('express').Router} router
 * @param {{games:Pick<import('../services/games').GamesService,'neighbors'>}} deps */
function registerGameNeighborsRoute(router, deps) {
  router.get("/games/:gameId/neighbors", async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      if (!req.auth) throw new Error("auth_required");
      const result = await deps.games.neighbors(req.auth.userId, String(req.params.gameId), {
        scope: req.query.scope,
        filters: parseFilters(req.query),
        result: req.query.result,
        matchup: req.query.matchup,
        search: typeof req.query.q === "string" ? req.query.q : req.query.search,
      });
      if (!result) { res.status(404).json({ error: { code: "not_found" } }); return; }
      res.json(result);
    } catch (error) { next(error); }
  });
}

module.exports = { registerGameNeighborsRoute };
