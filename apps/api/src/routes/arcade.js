"use strict";

const express = require("express");

/**
 * /v1/arcade/* — Arcade-specific endpoints.
 *
 *   POST /arcade/quests/resolve     — re-evaluate active Bingo card
 *   GET  /arcade/leaderboard        — current Stock Market weekly P&L
 *   POST /arcade/leaderboard        — opt-in submit weekly P&L
 *
 * The leaderboard endpoints live under /arcade (not /community) because
 * the data is single-user (one row per user per week) — the community
 * service operates on shared aggregates and would need k-anon math here
 * for no benefit. The Community → Leaderboard sub-tab consumes
 * /arcade/leaderboard directly.
 *
 * @param {{
 *   arcade: import('../services/arcade').ArcadeService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildArcadeRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.post("/arcade/quests/resolve", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const card = req.body && typeof req.body === "object" ? req.body.card : null;
      if (!card) {
        res.status(400).json({ error: { code: "card_required" } });
        return;
      }
      const result = await deps.arcade.resolveQuests(userId, card);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/arcade/leaderboard", async (req, res, next) => {
    try {
      requireAuth(req); // auth required so we don't expose handles publicly
      const weekKey = String(req.query.weekKey || "").trim();
      if (!weekKey) {
        res.status(400).json({ error: { code: "weekKey_required" } });
        return;
      }
      const limit = req.query.limit
        ? Number.parseInt(String(req.query.limit), 10)
        : undefined;
      const out = await deps.arcade.listLeaderboard(weekKey, { limit });
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  router.post("/arcade/leaderboard", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const ok = await deps.arcade.submitLeaderboard(userId, req.body || {});
      if (!ok) {
        res.status(400).json({ error: { code: "invalid_entry" } });
        return;
      }
      res.status(202).json({ ok: true });
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
    /** @type {any} */ (err).code = "auth_required";
    throw err;
  }
  return req.auth;
}

module.exports = { buildArcadeRouter };
