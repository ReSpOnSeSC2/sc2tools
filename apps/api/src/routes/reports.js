"use strict";

const express = require("express");

/**
 * Owner-only reports (docs/notifications.md).
 *
 *   GET /reports/weekly?week=YYYY-Www&tz=Zone   — one local ISO week next to the week before
 *   GET /reports/streams?before=&limit=         — the newest stream reports first
 *   GET /reports/streams/:id                    — one stream report
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
  return router;
}

/** @param {import('express').Request} req */
function owner(req) {
  if (!req.auth || !req.auth.userId) throw Object.assign(new Error("auth_required"), { status: 401, code: "auth_required" });
  return req.auth.userId;
}

module.exports = { buildReportsRouter };
