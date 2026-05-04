"use strict";

const express = require("express");

/**
 * /v1/import/{scan,start,cancel,status,cores,extract-identities,
 *             pick-folder,host-info,progress} — bulk historical
 * import flow.
 *
 * The cloud doesn't have access to the user's local replay folder,
 * so each route is a thin shim that broadcasts a Socket.io request to
 * the user's connected agent and tracks the resulting job in
 * `import_jobs`. The agent reports progress back via
 * /v1/import/progress.
 *
 * @param {{
 *   imports: import('../services/types').ImportService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildImportsRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.post("/import/scan", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.status(202).json(await deps.imports.scan(userId, req.body || {}));
    } catch (err) {
      next(err);
    }
  });

  router.post("/import/start", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.status(202).json(await deps.imports.start(userId, req.body || {}));
    } catch (err) {
      next(err);
    }
  });

  router.post("/import/cancel", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.json(await deps.imports.cancel(userId));
    } catch (err) {
      next(err);
    }
  });

  router.get("/import/status", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.json(await deps.imports.status(userId));
    } catch (err) {
      next(err);
    }
  });

  router.get("/import/jobs", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.json(await deps.imports.list(userId));
    } catch (err) {
      next(err);
    }
  });

  router.get("/import/cores", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.json(await deps.imports.cores(userId));
    } catch (err) {
      next(err);
    }
  });

  router.post("/import/host-info", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.json(await deps.imports.setHostInfo(userId, req.body || {}));
    } catch (err) {
      next(err);
    }
  });

  router.post("/import/progress", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const body = req.body || {};
      if (!body.jobId) {
        res.status(400).json({ error: { code: "jobId_required" } });
        return;
      }
      res.json(
        await deps.imports.reportProgress(userId, String(body.jobId), body),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post("/import/extract-identities", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res
        .status(202)
        .json(await deps.imports.extractIdentities(userId, req.body || {}));
    } catch (err) {
      next(err);
    }
  });

  router.post("/import/pick-folder", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      res.status(202).json(await deps.imports.pickFolder(userId));
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

module.exports = { buildImportsRouter };
