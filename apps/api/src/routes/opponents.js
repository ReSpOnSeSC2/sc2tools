"use strict";

const express = require("express");

/**
 * /v1/opponents — list and detail.
 *
 * @param {{
 *   opponents: import('../services/types').OpponentsService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildOpponentsRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/opponents", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const limit = parseLimit(req.query.limit);
      const before = parseDate(req.query.before);
      const result = await deps.opponents.list(auth.userId, { limit, before });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/opponents/:pulseId", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const opp = await deps.opponents.get(
        auth.userId,
        String(req.params.pulseId),
      );
      if (!opp) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.json(opp);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {unknown} raw @returns {number|undefined} */
function parseLimit(raw) {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** @param {unknown} raw @returns {Date|undefined} */
function parseDate(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

module.exports = { buildOpponentsRouter };
