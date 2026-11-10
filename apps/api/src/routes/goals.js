"use strict";

const express = require("express");

const PRIVATE_NO_STORE = "private, no-store";

/**
 * /v1/goals — the signed-in player's personal goals.
 *
 *   GET    /goals       active goals with live progress + completed history
 *   POST   /goals       create (409 goal_limit past 8 active goals)
 *   PUT    /goals/:id   pin, retitle or re-measure an active goal
 *   DELETE /goals/:id   delete any goal
 *
 * Every response is the full list (services/playerGoals.js ``list``), so a
 * client replaces its cache without a second read. Auth is applied per
 * route: this router is mounted on the shared /v1 prefix.
 *
 * @param {{
 *   goals: import('../services/playerGoals').PlayerGoalsService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildGoalsRouter(deps) {
  const router = express.Router();

  /** @param {import('express').Request} req */
  function owner(req) {
    const userId = req.auth && req.auth.userId;
    if (typeof userId !== "string" || !userId) throw new Error("auth_required");
    return userId;
  }

  /**
   * @param {(req: import('express').Request, res: import('express').Response) => Promise<void>} work
   * @returns {import('express').RequestHandler}
   */
  function handle(work) {
    return async (req, res, next) => {
      res.set("Cache-Control", PRIVATE_NO_STORE);
      try {
        await work(req, res);
      } catch (err) {
        const coded = /** @type {{status?: number, code?: string, message?: string}} */ (err);
        if (coded && typeof coded.status === "number" && coded.status < 500 && coded.code) {
          res.status(coded.status).json({ error: { code: coded.code, message: coded.message } });
          return;
        }
        next(err);
      }
    };
  }

  router.get("/goals", deps.auth, handle(async (req, res) => {
    res.json(await deps.goals.list(owner(req)));
  }));

  router.post("/goals", deps.auth, handle(async (req, res) => {
    res.status(201).json(await deps.goals.create(owner(req), req.body));
  }));

  router.put("/goals/:id", deps.auth, handle(async (req, res) => {
    res.json(await deps.goals.update(owner(req), String(req.params.id), req.body));
  }));

  router.delete("/goals/:id", deps.auth, handle(async (req, res) => {
    res.json(await deps.goals.remove(owner(req), String(req.params.id)));
  }));

  return router;
}

module.exports = { buildGoalsRouter };
