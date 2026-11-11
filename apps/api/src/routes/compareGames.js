"use strict";

const express = require("express");
const { publicReplayReference, publicReplayObjectId } = require("../util/publicReplayReference");

const COMPARE_GAMES = "/compare-games";
const ACTIVE_GAME = { _deleted: { $ne: true }, _deletionPending: { $ne: true } };

/** @param {unknown} value @returns {value is string} */
function legacyGameId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** @param {import('express').Response} res @param {number} status @param {string} code */
function problem(res, status, code) {
  return res.status(status).json({ error: { code } });
}

/** @param {{db: import('../db/connect').DbContext,
 * games: Pick<import('../services/types').GamesService, 'get'>,
 * perGame: Pick<import('../services/types').PerGameComputeService, 'macroBreakdown'|'buildOrder'>,
 * auth: import('express').RequestHandler}} deps */
function buildCompareGamesRouter(deps) {
  const router = express.Router();
  const game = (/** @type {string} */ userId, /** @type {string} */ id) => deps.games.get(userId, id);
  const macro = (/** @type {string} */ userId, /** @type {string} */ id) => deps.perGame.macroBreakdown(userId, id);
  const build = (/** @type {string} */ userId, /** @type {string} */ id) => deps.perGame.buildOrder(userId, id);

  router.post(COMPARE_GAMES + "/references", deps.auth, async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    const ids = req.body?.gameIds;
    if (!req.auth) return problem(res, 401, "auth_required");
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 2 || !ids.every(legacyGameId)) {
      return problem(res, 400, "invalid_compare_game_ids");
    }
    try {
      const rows = await deps.db.games.find({ ...ACTIVE_GAME, userId: req.auth.userId, gameId: { $in: ids } },
        { projection: { _id: 1, gameId: 1 } }).toArray();
      const references = new Map(rows.map(row => [row.gameId, publicReplayReference(row._id)]));
      res.json({ references: ids.map(id => references.get(id) ?? null) });
    } catch (err) { next(err); }
  });

  router.get(COMPARE_GAMES + "/:reference/:resource", deps.auth, async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.auth) return problem(res, 401, "auth_required");
    const { reference, resource } = req.params;
    const id = publicReplayObjectId(reference);
    const read = resource === "game" ? game : resource === "macro-breakdown" ? macro : resource === "build-order" ? build : null;
    if (!id || !read) return problem(res, 404, "game_not_found");
    try {
      const userId = req.auth.userId;
      const row = await deps.db.games.findOne({ ...ACTIVE_GAME, userId, _id: id }, { projection: { _id: 0, gameId: 1 } });
      if (typeof row?.gameId !== "string") return problem(res, 404, "game_not_found");
      const out = await read(userId, row.gameId);
      if (!out) return problem(res, 404, "game_not_found");
      if (resource === "macro-breakdown" && "code" in out && out.code === "not_computed") {
        return problem(res, 404, "macro_not_computed");
      }
      res.json(out);
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { buildCompareGamesRouter };
