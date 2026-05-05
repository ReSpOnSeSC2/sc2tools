"use strict";

const express = require("express");
const { validateProfile } = require("../validation/profile");

/**
 * /v1/me — sanity endpoint for the web app. Returns the user record
 * + last-sync timestamps so the SPA can render onboarding state.
 *
 * Also hosts:
 *   GET    /me/profile   — read battleTag/pulseId/region/preferredRace/displayName
 *   PUT    /me/profile   — replace those fields (also reachable via the
 *                          agent's device-token, so the desktop app can
 *                          read its handle from the cloud after pairing)
 *   GET    /me/export    — download every per-user record as JSON
 *   DELETE /me           — permanently delete the account
 *   GET    /me/backups   — list manual snapshots
 *   POST   /me/backups   — take a manual snapshot
 *   POST   /me/backups/:id/restore — restore from a snapshot
 *
 * @param {{
 *   users: import('../services/types').UsersService,
 *   games: import('../services/types').GamesService,
 *   gdpr: import('../services/gdpr').GdprService,
 *   auth: import('express').RequestHandler,
 *   logger?: import('pino').Logger,
 * }} deps
 */
function buildMeRouter(deps) {
  const router = express.Router();

  // Auth applied per-route, NOT via router.use(). Router-level middleware
  // here would intercept every /v1/* request that doesn't match an
  // earlier-mounted router, blocking unauthenticated endpoints like
  // /v1/device-pairings/start with a spurious 401.
  router.get("/me", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      await deps.users.touch(auth.userId);
      const stats = await deps.games.stats(auth.userId);
      res.json({
        userId: auth.userId,
        source: auth.source,
        games: stats,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/me/profile", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const profile = await deps.users.getProfile(auth.userId);
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

  router.put("/me/profile", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const result = validateProfile(req.body);
      if (!result.valid) {
        res.status(400).json({
          error: { code: "invalid_profile", details: result.errors },
        });
        return;
      }
      const profile = await deps.users.updateProfile(auth.userId, result.value);
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

  router.get("/me/export", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const data = await deps.gdpr.export(auth.userId);
      const filename = `sc2tools-export-${Date.now()}.json`;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader(
        "content-disposition",
        `attachment; filename="${filename}"`,
      );
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/me", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const counts = await deps.gdpr.deleteAll(auth.userId);
      if (deps.logger) {
        deps.logger.info(
          { userId: auth.userId, counts },
          "gdpr_account_deleted",
        );
      }
      res.json({ deleted: true, counts });
    } catch (err) {
      next(err);
    }
  });

  router.get("/me/backups", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const result = await deps.gdpr.listSnapshots(auth.userId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/backups", deps.auth, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const snap = await deps.gdpr.snapshot(auth.userId);
      res.status(201).json(snap);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/me/backups/:id/restore",
    deps.auth,
    async (req, res, next) => {
      try {
        const auth = req.auth;
        if (!auth) throw new Error("auth_required");
        const result = await deps.gdpr.restoreSnapshot(
          auth.userId,
          String(req.params.id),
        );
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

module.exports = { buildMeRouter };
