"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/**
 * Opt-in supporter wall (/donate):
 *   GET    /public/supporters        approved entries
 *   GET    /me/supporter-wall        the caller's own entry
 *   PUT    /me/supporter-wall        add/update it with explicit consent (pending review)
 *   DELETE /me/supporter-wall        remove it (revocation)
 *   GET    /admin/supporters         moderation queue (?status=pending|approved|rejected)
 *   PATCH  /admin/supporters/:id     { status: "approved" | "rejected" }
 *   DELETE /admin/supporters/:id     remove an entry
 *
 * @param {{supporterWall: import('../services/supporterWall').SupporterWallService, auth: import('express').RequestHandler, isAdmin: (req: import('express').Request) => boolean}} deps
 */
function buildSupporterWallRouter(deps) {
  const router = express.Router();
  const writeLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Always after auth, so the account is the key.
    keyGenerator: (/** @type {import('express').Request} */ req) => `supporter-wall:${req.auth?.userId || "anonymous"}`,
    message: { error: { code: "supporter_wall_rate_limited", message: "Please wait a while before changing your supporter wall entry again." } },
  });
  const owner = (/** @type {import('express').Request} */ req) => /** @type {any} */ (req.auth).userId;

  router.get("/public/supporters", async (_req, res, next) => {
    try {
      const wall = await deps.supporterWall.listPublic();
      res.set("Cache-Control", "no-store").json(wall);
    } catch (err) { next(err); }
  });
  router.get("/me/supporter-wall", deps.auth, async (req, res, next) => {
    try { res.set("Cache-Control", "private, no-store").json(await deps.supporterWall.getSelf(owner(req))); } catch (err) { next(err); }
  });
  router.put("/me/supporter-wall", deps.auth, writeLimit, async (req, res, next) => {
    try { res.set("Cache-Control", "private, no-store").json(await deps.supporterWall.saveSelf(owner(req), req.body)); } catch (err) { next(err); }
  });
  router.delete("/me/supporter-wall", deps.auth, async (req, res, next) => {
    try { res.set("Cache-Control", "private, no-store").json(await deps.supporterWall.removeSelf(owner(req))); } catch (err) { next(err); }
  });
  router.get("/public/donations/current", async (_req, res, next) => {
    try {
      const month = await deps.supporterWall.currentMonth();
      res.set("Cache-Control", "public, max-age=60, s-maxage=600").json(month);
    } catch (err) { next(err); }
  });
  router.use(["/admin/supporters", "/admin/donations"], deps.auth, (req, res, next) => {
    if (!deps.isAdmin(req)) { res.status(403).json({ error: { code: "admin_only" } }); return; }
    res.set("Cache-Control", "private, no-store");
    next();
  });
  router.get("/admin/supporters", async (req, res, next) => {
    try { res.json(await deps.supporterWall.listAdmin({ status: req.query.status })); } catch (err) { next(err); }
  });
  router.patch("/admin/supporters/:id", async (req, res, next) => {
    try { res.json(await deps.supporterWall.review(String(req.params.id), req.body, owner(req))); } catch (err) { next(err); }
  });
  router.delete("/admin/supporters/:id", async (req, res, next) => {
    try { res.json(await deps.supporterWall.removeAdmin(String(req.params.id))); } catch (err) { next(err); }
  });
  router.get("/admin/donations/:month", async (req, res, next) => {
    try { res.json(await deps.supporterWall.readMonth(String(req.params.month))); } catch (err) { next(err); }
  });
  router.put("/admin/donations/:month", async (req, res, next) => {
    try { res.json(await deps.supporterWall.saveMonth(String(req.params.month), req.body)); } catch (err) { next(err); }
  });
  return router;
}

module.exports = { buildSupporterWallRouter };
