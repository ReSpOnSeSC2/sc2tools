"use strict";

/**
 * /v1/admin/* — operational admin routes.
 *
 * Every endpoint here is gated by ``isAdmin(req)`` (Clerk user ID
 * matched against ``SC2TOOLS_ADMIN_USER_IDS``). Non-admins get a 403
 * with no body — the SPA hides the Admin link entirely for those
 * users via ``/v1/me.isAdmin``, so a 403 here only fires on direct
 * URL access.
 *
 * Endpoints
 * ---------
 *
 *   GET  /admin/storage-stats       per-collection size + total
 *   GET  /admin/users               paginated user list w/ activity
 *   GET  /admin/users/:userId       per-user detail snapshot
 *   POST /admin/users/:userId/rebuild-opponents
 *                                    drop + re-derive opponents from games
 *   POST /admin/users/:userId/wipe-games
 *                                    GDPR wipe (delegates to GdprService)
 *   POST /admin/me/rebuild-opponents
 *                                    convenience for the calling admin's
 *                                    own opponents row — drives the
 *                                    "Fix my counters" button on /admin
 *   GET  /admin/health              Mongo ping, uptime, runtime info
 */

const express = require("express");

/**
 * @param {{
 *   admin: import('../services/admin').AdminService,
 *   gdpr: import('../services/gdpr').GdprService,
 *   auth: import('express').RequestHandler,
 *   isAdmin: (req: any) => boolean,
 *   gameDetailsStoreKind?: string,
 * }} deps
 */
function buildAdminRouter(deps) {
  const router = express.Router();
  // Scope the auth + admin gate to ``/admin/*`` only. ``router.use(...)``
  // without a path argument runs for every request that reaches this
  // router — including non-admin ``/v1/*`` requests that just happen
  // to pass through this router on the way to a downstream handler
  // — which would 403 unrelated traffic.
  router.use("/admin", deps.auth);
  router.use("/admin", (req, res, next) => {
    if (!deps.isAdmin(req)) {
      res.status(403).json({ error: { code: "admin_only" } });
      return;
    }
    next();
  });

  router.get("/admin/storage-stats", async (_req, res, next) => {
    try {
      res.json(await deps.admin.storageStats());
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/users", async (req, res, next) => {
    try {
      const limit = parseLimit(req.query.limit);
      const before = parseDate(req.query.before);
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      res.json(await deps.admin.listUsers({ limit, before, search }));
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/users/:userId", async (req, res, next) => {
    try {
      const detail = await deps.admin.userDetail(String(req.params.userId));
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/admin/users/:userId/rebuild-opponents",
    async (req, res, next) => {
      try {
        const result = await deps.admin.rebuildOpponentsForUser(
          String(req.params.userId),
        );
        res.status(202).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/admin/users/:userId/wipe-games",
    async (req, res, next) => {
      try {
        // GDPR.wipeGames is the single source of truth for cascading
        // a user's data delete (games + game_details + opponents
        // re-derive + macroJobs). The admin route just delegates.
        const result = await deps.gdpr.wipeGames(
          String(req.params.userId),
          {},
        );
        res.status(202).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * "Rebuild MY opponents" — the most common single-button action
   * for the admin themselves after a buggy re-sync. We pull the
   * caller's userId off ``req.auth`` (set by the auth middleware)
   * so the SPA doesn't have to round-trip /v1/me first.
   */
  router.post("/admin/me/rebuild-opponents", async (req, res, next) => {
    try {
      const userId = req.auth && req.auth.userId;
      if (!userId) {
        res.status(401).json({ error: { code: "auth_required" } });
        return;
      }
      const result = await deps.admin.rebuildOpponentsForUser(userId);
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/health", async (_req, res, next) => {
    try {
      res.json(
        await deps.admin.health({
          gameDetailsStoreKind: deps.gameDetailsStoreKind,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {unknown} raw */
function parseLimit(raw) {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** @param {unknown} raw */
function parseDate(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

module.exports = { buildAdminRouter };
