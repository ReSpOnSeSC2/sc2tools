"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/** @param {{playerChannels:import('../services/playerChannels').PlayerChannelsService,auth:import('express').RequestHandler,isAdmin:(req:import('express').Request)=>boolean}} deps */
function buildPlayerChannelsRouter(deps) {
  const router = express.Router();
  const resolveLimit = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false, message: { error: { code: "player_channels_rate_limited", message: "Please wait a moment before looking up more player channels." } } });
  // Deliberately public: links are the same for all users, with no tenant data.
  router.post("/player-channels/resolve", resolveLimit, async (req, res, next) => {
    try { res.set("Cache-Control", "no-store").json(await deps.playerChannels.resolve(req.body?.players)); } catch (err) { next(err); }
  });
  router.get("/me/player-channels", deps.auth, async (req, res, next) => {
    try { res.set("Cache-Control", "private, no-store").json(await deps.playerChannels.getSelf(/** @type {any} */ (req.auth).userId)); } catch (err) { next(err); }
  });
  router.put("/me/player-channels", deps.auth, async (req, res, next) => {
    try { res.set("Cache-Control", "private, no-store").json(await deps.playerChannels.saveSelf(/** @type {any} */ (req.auth).userId, req.body)); } catch (err) { next(err); }
  });
  router.use("/admin/player-channels", deps.auth, (req, res, next) => {
    if (!deps.isAdmin(req)) { res.status(403).json({ error: { code: "admin_only" } }); return; }
    res.set("Cache-Control", "private, no-store");
    next();
  });
  router.get("/admin/player-channels", async (req, res, next) => {
    try { res.json(await deps.playerChannels.list({ search: req.query.search, page: req.query.page, limit: req.query.limit, includeRemoved: req.query.includeRemoved === "true", pendingOnly: req.query.pendingOnly === "true" })); } catch (err) { next(err); }
  });
  router.post("/admin/player-channels/import-pulse", async (_req, res, next) => {
    try { res.json(await deps.playerChannels.importPulse()); } catch (err) { next(err); }
  });
  router.post("/admin/player-channels", async (req, res, next) => {
    try { res.status(201).json(await deps.playerChannels.saveAdmin(req.body, /** @type {any} */ (req.auth).userId)); } catch (err) { next(err); }
  });
  router.put("/admin/player-channels/:id", async (req, res, next) => {
    try { res.json(await deps.playerChannels.saveAdmin(req.body, /** @type {any} */ (req.auth).userId, String(req.params.id))); } catch (err) { next(err); }
  });
  router.delete("/admin/player-channels/:id", async (req, res, next) => {
    try { res.json(await deps.playerChannels.removeAdmin(String(req.params.id), /** @type {any} */ (req.auth).userId)); } catch (err) { next(err); }
  });
  return router;
}

module.exports = { buildPlayerChannelsRouter };
