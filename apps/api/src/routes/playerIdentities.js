"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/** @param {{playerIdentities:import('../services/playerIdentities').PlayerIdentitiesService,auth:import('express').RequestHandler,isAdmin:(req:import('express').Request)=>boolean}} deps */
function buildPlayerIdentitiesRouter(deps) {
  const router = express.Router();
  const service = deps.playerIdentities;
  const limit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false });
  const writeLimit = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: "draft-7", legacyHeaders: false });
  /** @type {import('express').RequestHandler} */
  const privateResponse = (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); };
  /** @type {import('express').RequestHandler} */
  const admin = (req, res, next) => { if (!deps.isAdmin(req)) { res.status(403).json({ error: { code: "admin_only", message: "Administrator access is required." } }); return; } next(); };
  router.use(["/player-identities", "/admin/player-identities", "/opponents/:pulseId/identity-submissions", "/opponents/:pulseId/confirmed-identity"], deps.auth, privateResponse);
  router.get("/player-identities/search", limit, async (req, res, next) => {
    try { res.json(await service.directory.search(req.query.q, req.query.cursor)); } catch (err) { next(err); }
  });
  router.post("/player-identities/pulse", writeLimit, async (req, res, next) => {
    try { res.json(await service.importPulse(req.body?.profile)); } catch (err) { next(err); }
  });
  router.get("/opponents/:pulseId/identity-submissions", async (req, res, next) => {
    try { res.json(await service.context(/** @type {any} */ (req.auth).userId, req.params.pulseId, deps.isAdmin(req))); } catch (err) { next(err); }
  });
  router.post("/opponents/:pulseId/identity-submissions", writeLimit, async (req, res, next) => {
    try { res.json(await service.submit(/** @type {any} */ (req.auth).userId, req.params.pulseId, req.body)); } catch (err) { next(err); }
  });
  router.put("/opponents/:pulseId/confirmed-identity", admin, writeLimit, async (req, res, next) => {
    try { res.json(await service.confirm(/** @type {any} */ (req.auth).userId, req.params.pulseId, req.body)); } catch (err) { next(err); }
  });
  router.delete("/opponents/:pulseId/confirmed-identity", admin, writeLimit, async (req, res, next) => {
    try { res.json(await service.confirm(/** @type {any} */ (req.auth).userId, req.params.pulseId, req.body, true)); } catch (err) { next(err); }
  });
  router.use("/admin/player-identities", admin);
  router.get("/admin/player-identities", async (req, res, next) => {
    try { res.json(await service.list(req.query)); } catch (err) { next(err); }
  });
  router.get("/admin/player-identities/:id", async (req, res, next) => {
    try { res.json(await service.detail(req.params.id, req.query.cursor)); } catch (err) { next(err); }
  });
  router.post("/admin/player-identities/:id/review", writeLimit, async (req, res, next) => {
    try { res.json(await service.review(req.params.id, /** @type {any} */ (req.auth).userId, req.body)); } catch (err) { next(err); }
  });
  return router;
}

module.exports = { buildPlayerIdentitiesRouter };
