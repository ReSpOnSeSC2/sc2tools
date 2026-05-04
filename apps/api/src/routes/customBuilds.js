"use strict";

const express = require("express");
const { validateCustomBuild } = require("../validation/customBuild");

/**
 * /v1/custom-builds — user's private build library.
 *
 * @param {{
 *   customBuilds: import('../services/types').CustomBuildsService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildCustomBuildsRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/custom-builds", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const items = await deps.customBuilds.list(auth.userId);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.get("/custom-builds/:slug", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const item = await deps.customBuilds.get(
        auth.userId,
        String(req.params.slug),
      );
      if (!item) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.json(item);
    } catch (err) {
      next(err);
    }
  });

  router.put("/custom-builds/:slug", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const slug = String(req.params.slug);
      const validation = validateCustomBuild({ ...req.body, slug });
      if (!validation.valid) {
        res.status(400).json({
          error: { code: "bad_request", details: validation.errors },
        });
        return;
      }
      await deps.customBuilds.upsert(
        auth.userId,
        /** @type {any} */ (validation.value),
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.delete("/custom-builds/:slug", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      await deps.customBuilds.softDelete(auth.userId, String(req.params.slug));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildCustomBuildsRouter };
