"use strict";

const express = require("express");

/**
 * /v1/practice/* — the signed-in owner's private practice log.
 *
 *   GET  /practice/summary?matchup=PvZ[&targetHash=]   progress for a target
 *   GET  /practice/games?matchup=PvZ[&targetHash=&cursor=&limit=]  graded games, paged
 *   GET  /practice/games/:gameId                       one game's stored grade
 *   GET  /practice/quest?day=YYYY-MM-DD&tz=IANA        Arcade's daily practice quest
 *   PUT  /practice/checkpoints                       update a slot's private checkpoints
 *   POST /practice/grade-recent {matchup}              grade the newest ungraded games, at most 20
 *
 * Owner-only by construction: every handler reads ``req.auth.userId``. No
 * coach, public, share or review route reads these records.
 *
 * @param {{
 *   practice: import('../services/practiceLog').PracticeLogService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildPracticeRouter(deps) {
  const router = express.Router();
  router.use("/practice", deps.auth, (req, res, next) => {
    if (!req.auth?.userId) {
      next(Object.assign(new Error("auth_required"), { status: 401, code: "auth_required" }));
      return;
    }
    res.set("Cache-Control", "private, no-store");
    next();
  });
  router.get("/practice/summary", wrap(async (req, res) => {
    res.json(await deps.practice.summary(owner(req), req.query));
  }));
  router.get("/practice/games", wrap(async (req, res) => {
    res.json(await deps.practice.games(owner(req), req.query));
  }));
  router.get("/practice/games/:gameId", wrap(async (req, res) => {
    const gameId = String(req.params.gameId || "");
    if (!gameId || gameId.length > 200) {
      res.status(400).json({ error: { code: "invalid_game_id" } });
      return;
    }
    res.json({ practice: await deps.practice.game(owner(req), gameId) });
  }));
  router.get("/practice/quest", wrap(async (req, res) => {
    res.json(await deps.practice.dailyQuest(owner(req), req.query));
  }));
  router.put("/practice/checkpoints", wrap(async (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    res.json(await deps.practice.saveCheckpoints(owner(req), body));
  }));
  router.post("/practice/grade-recent", wrap(async (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    res.json(await deps.practice.gradeRecent(owner(req), { matchup: body.matchup }));
  }));
  return router;
}

/** @param {import('express').Request} req */
function owner(req) {
  return /** @type {{userId: string}} */ (req.auth).userId;
}

/** @param {(req: import('express').Request, res: import('express').Response) => Promise<void>} handler
 * @returns {import('express').RequestHandler} */
function wrap(handler) {
  return (req, res, next) => { Promise.resolve(handler(req, res)).catch(next); };
}

module.exports = { buildPracticeRouter };
