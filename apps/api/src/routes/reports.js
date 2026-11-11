"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const rateLimit = /** @type {any} */ (rateLimitModule).default || rateLimitModule;

/**
 * Owner-only reports (docs/notifications.md).
 *
 *   GET /reports/weekly?week=YYYY-Www&tz=Zone   — one local ISO week next to the week before
 *   GET /reports/streams?before=&limit=         — the newest stream reports first
 *   GET /reports/streams/:id                    — one stream report
 *   PATCH /reports/streams/:id/sharing          — publish or revoke a report
 *   PUT /reports/streams/:id/vod                — attach or remove a recording
 *   GET /public/players/:slug/streams/:id       — published aggregate report
 *
 * @param {{
 *   weekly: import('../services/weeklyReport').WeeklyReportService,
 *   streams: import('../services/streamReports').StreamReportsService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildReportsRouter(deps) {
  const router = express.Router();
  router.get("/reports/weekly", deps.auth, async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      res.json(await deps.weekly.report(owner(req), { week: req.query.week, tz: req.query.tz }));
    } catch (err) { next(err); }
  });
  router.get("/reports/streams", deps.auth, async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      res.json(await deps.streams.list(owner(req), { before: req.query.before, limit: req.query.limit }));
    } catch (err) { next(err); }
  });
  router.get("/reports/streams/:id", deps.auth, async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      const report = await deps.streams.get(owner(req), req.params.id);
      if (!report) { res.status(404).json({ error: { code: "stream_report_not_found", message: "That stream report doesn't exist or was replaced by newer ones." } }); return; }
      res.json(report);
    } catch (err) { next(err); }
  });
  router.put("/reports/streams/:id/vod", deps.auth, async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      if (req.auth?.source !== "clerk") throw Object.assign(new Error("Sign in on the website to edit the recording."), { status: 403, code: "browser_session_required" });
      res.json(await deps.streams.setVod(owner(req), req.params.id, req.body?.url));
    } catch (error) { next(error); }
  });
  mountStreamPublication(router, deps);
  return router;
}

/** @param {import('express').Router} router @param {Parameters<typeof buildReportsRouter>[0]} deps */
function mountStreamPublication(router, deps) {
  router.patch("/reports/streams/:id/sharing", deps.auth, async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      if (req.auth?.source !== "clerk") throw Object.assign(new Error("Sign in on the website to share a report."), { status: 403, code: "browser_session_required" });
      res.json(await deps.streams.publication.update(owner(req), req.params.id, req.body?.enabled));
    } catch (error) { next(error); }
  });
  const limit = rateLimit({
    windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 4096 }),
    keyGenerator: (/** @type {import('express').Request} */ req) => `${req.ip}:${String(req.params.slug).slice(0, 64)}`,
    message: { error: { code: "rate_limited", message: "Too many requests. Try again in a minute." } },
  });
  router.get("/public/players/:slug/streams/:id", limit, async (req, res, next) => {
    try {
      res.set({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" });
      const report = await deps.streams.publication.read(req.params.slug, req.params.id);
      if (!report) { res.status(404).json({ error: { code: "stream_report_not_found", message: "This stream report is unavailable." } }); return; }
      res.json(report);
    } catch (error) { next(error); }
  });
}

/** @param {import('express').Request} req */
function owner(req) {
  if (!req.auth || !req.auth.userId) throw Object.assign(new Error("auth_required"), { status: 401, code: "auth_required" });
  return req.auth.userId;
}

module.exports = { buildReportsRouter };
