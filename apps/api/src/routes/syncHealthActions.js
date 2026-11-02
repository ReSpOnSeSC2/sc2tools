"use strict";
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { SyncHealthFixes } = require("../services/syncHealthFixes");

/** @param {{auth:import('express').RequestHandler, users:import('mongodb').Collection<any>, pairings:ConstructorParameters<typeof SyncHealthFixes>[0]['pairings'],io?:any,timeoutMs?:number}} deps */
function buildSyncHealthActionsRouter(deps) {
  const router = express.Router(), service = new SyncHealthFixes(deps);
  /** @type {import('express').RequestHandler} */
  const owner = (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.auth?.userId || req.auth.source !== "clerk") { res.status(403).json({ error: { code: "sync_owner_session_required" } }); return; }
    if (Object.keys(req.query).length) { res.status(400).json({ error: { code: "sync_fix_invalid" } }); return; }
    next();
  };
  /** @param {number} limit */
  const limiter = limit => rateLimit({ windowMs: 60000, limit, standardHeaders: "draft-7", legacyHeaders: false,
    keyGenerator: req => String(req.auth?.userId), store: new BoundedRateLimitStore({ maxEntries: 4096 }) });
  router.post("/identity", deps.auth, owner, limiter(20), async (req, res, next) => {
    try { res.json(await service.identity(String(req.auth?.userId), req.body)); } catch (error) { next(error); }
  });
  router.post("/retry", deps.auth, owner, limiter(6), async (req, res, next) => {
    try { res.json(await service.retry(String(req.auth?.userId), req.body)); } catch (error) { next(error); }
  });
  return router;
}
module.exports = { buildSyncHealthActionsRouter };
