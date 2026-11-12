"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { playerError } = require("../util/publicPlayerConfig");
const rateLimit = rateLimitModule.rateLimit;

/** @param {{viewer:import("../services/streamViewer").StreamViewerService,auth:import("express").RequestHandler,limit?:number}} deps */
function buildStreamViewerRouter({ viewer, auth, limit = 60 }) {
  const router = express.Router();
  const publicLimit = rateLimit({ windowMs: 60_000, max: limit, standardHeaders: true, legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }),
    message: { error: { code: "rate_limited", message: "Too many requests. Try again in a minute." } } });
  router.get("/public/players/:slug/live", (_req, res, next) => {
    res.set({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" }); next();
  }, publicLimit, async (req, res, next) => {
    try {
      const data = await viewer.read(req.params.slug);
      if (!data) {
        res.status(404).json({ error: { code: "stream_viewer_not_found", message: "This viewer page is unavailable." } });
        return;
      }
      res.json(data);
    } catch { next(playerError(503, "stream_viewer_unavailable", "The latest results couldn't load.")); }
  });
  router.route("/me/stream-viewer")
    .all((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); }, auth, requireOwner)
    .get(async (req, res, next) => {
      try { res.json(await viewer.getSettings(req.auth?.userId ?? "")); } catch (error) { next(error); }
    }).put(async (req, res, next) => {
      try { res.json(await viewer.setSettings(req.auth?.userId ?? "", req.body)); } catch (error) { next(error); }
    });
  return router;
}

/** @type {import("express").RequestHandler} */
function requireOwner(req, _res, next) {
  if (req.auth?.source === "clerk" && req.auth.userId) next();
  else next(playerError(403, "browser_session_required", "Sign in on the website to change the viewer page."));
}

module.exports = { buildStreamViewerRouter };
