"use strict";

const express = require("express");
const { parseFilters } = require("../util/parseQuery");

/**
 * /v1/builds, /v1/opp-strategies — analytics over the user's build
 * library and detected opponent strategies.
 *
 * @param {{
 *   builds: import('../services/types').BuildsService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildBuildsRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/builds", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.json(await deps.builds.list(userId, parseFilters(req.query)));
    } catch (err) {
      next(err);
    }
  });

  router.get("/builds/:name", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const name = String(req.params.name || "");
      const detail = await deps.builds.detail(
        userId,
        name,
        parseFilters(req.query),
      );
      if (!detail) {
        res.status(404).json({ error: { code: "build_not_found" } });
        return;
      }
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  router.get("/opp-strategies", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.json(
        await deps.builds.oppStrategies(userId, parseFilters(req.query)),
      );
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

module.exports = { buildBuildsRouter };
