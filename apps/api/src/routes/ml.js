"use strict";

const express = require("express");

/**
 * /v1/ml/{status,train,predict,pregame,options}
 *
 * @param {{
 *   ml: import('../services/types').MLService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildMlRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/ml/status", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.json(await deps.ml.status(userId));
    } catch (err) {
      next(err);
    }
  });

  router.post("/ml/train", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const body = req.body || {};
      const out = await deps.ml.train(userId, { kind: body.kind });
      res.status(202).json(out);
    } catch (err) {
      next(err);
    }
  });

  router.get("/ml/predict", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const payload = {
        myRace: String(req.query.my_race || ""),
        oppRace: String(req.query.opp_race || ""),
        map: req.query.map ? String(req.query.map) : undefined,
        earlyBuildLog: parseBuildLog(req.query.early_build_log),
      };
      res.json(await deps.ml.predict(userId, payload));
    } catch (err) {
      next(err);
    }
  });

  router.get("/ml/pregame", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const payload = {
        myRace: String(req.query.my_race || ""),
        oppRace: String(req.query.opp_race || ""),
        map: req.query.map ? String(req.query.map) : undefined,
      };
      res.json(await deps.ml.pregame(userId, payload));
    } catch (err) {
      next(err);
    }
  });

  router.get("/ml/options", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.json(await deps.ml.options(userId));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {unknown} raw @returns {string[]} */
function parseBuildLog(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch (_e) {
      return raw.split("|").map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
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

module.exports = { buildMlRouter };
