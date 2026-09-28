"use strict";

const express = require("express");

/**
 * /v1/me/notifications — the signed-in user's in-app bell.
 *
 *   GET  /me/notifications               — newest first, ?limit=&before=
 *   GET  /me/notifications/unread-count  — {count} (capped at 100)
 *   POST /me/notifications/read          — {ids: string[]} or {all: true}
 *
 * Auth is applied per route (not ``router.use``) so mounting this router
 * on the shared /v1 prefix never intercepts public routes. The bell only
 * exists for the Replay Review Exchange, so while its rollout is "off"
 * every route 404s before auth runs.
 *
 * @param {{
 *   notifications: import('../services/notifications').NotificationsService,
 *   auth: import('express').RequestHandler,
 *   rollout?: "off" | "admins" | "on",
 * }} deps
 */
function buildNotificationsRouter(deps) {
  const router = express.Router();
  /** @type {import('express').RequestHandler} */
  const enabled = (req, res, next) => {
    if (deps.rollout !== "off") return next();
    res.set("Cache-Control", "no-store");
    res.status(404).json({ error: { code: "not_found", message: "Not found." } });
  };

  router.get("/me/notifications", enabled, deps.auth, async (req, res, next) => {
    try {
      const userId = requireUser(req);
      res.set("Cache-Control", "private, no-store");
      res.json(await deps.notifications.list(userId, {
        limit: req.query.limit,
        before: req.query.before,
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get("/me/notifications/unread-count", enabled, deps.auth, async (req, res, next) => {
    try {
      const userId = requireUser(req);
      res.set("Cache-Control", "private, no-store");
      res.json(await deps.notifications.unreadCount(userId));
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/notifications/read", enabled, deps.auth, async (req, res, next) => {
    try {
      const userId = requireUser(req);
      res.json(await deps.notifications.markRead(userId, req.body || {}));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {import('express').Request} req */
function requireUser(req) {
  if (!req.auth || !req.auth.userId) {
    throw Object.assign(new Error("auth_required"), { status: 401, code: "auth_required" });
  }
  return req.auth.userId;
}

module.exports = { buildNotificationsRouter };
