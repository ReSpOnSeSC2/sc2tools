"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { FILTERS, SORTS, EXPORT_LIMIT } = require("../services/adminUsers");

const invalid = () => Object.assign(new Error("Use a valid Users filter, sort and page."), { status: 400, code: "invalid_users_query" });
/** @param {unknown} value @param {number} fallback @param {number} max */
function positive(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d{0,6}$/.test(value) || Number(value) > max) throw invalid();
  return Number(value);
}
/** @param {import('express').Request['query']} query @param {boolean} [csv] */
function parseUsersQuery(query, csv = false) {
  const allowed = csv ? ["q", "search", "filter"] : ["q", "search", "filter", "sort", "order", "page", "limit", "before"];
  if (Object.keys(query).some(key => !allowed.includes(key))) throw invalid();
  const search = query.q ?? query.search ?? "";
  if (typeof search !== "string" || search.length > 200 || /[\u0000-\u001f\u007f]/.test(search)) throw invalid();
  if (query.q !== undefined && query.search !== undefined && query.q !== query.search) throw invalid();
  const filter = query.filter ?? "all", sort = query.sort ?? "lastActivity", order = query.order ?? "desc";
  if (typeof filter !== "string" || !FILTERS.has(filter) || typeof sort !== "string" || !Object.hasOwn(SORTS, sort) || !["asc", "desc"].includes(/** @type {string} */ (order))) throw invalid();
  let before;
  if (query.before !== undefined && query.before !== "") {
    if (typeof query.before !== "string" || query.page !== undefined || sort !== "lastActivity" || order !== "desc") throw invalid();
    before = new Date(query.before); if (!Number.isFinite(+before)) throw invalid();
  }
  return { search: search.trim(), filter, sort, order, page: positive(query.page, 1, 10_000), limit: positive(query.limit, 50, 200), before };
}

/** Mounted behind the parent's authenticated admin gate, before /:userId.
 * @param {{admin:import('../services/admin').AdminService,adminAudit?:Pick<import('../services/adminAudit').AdminAuditService,'audit'>}} deps */
function buildAdminUsersRouter(deps) {
  const router = express.Router();
  let exporting = false;
  const limiter = (rateLimitModule.default || rateLimitModule)({ windowMs: 60_000, max: 1, standardHeaders: true, legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: 1024 }),
    keyGenerator: (/** @type {import('express').Request} */ req) => `admin-users-csv:${req.auth?.userId || "anonymous"}`,
    message: { error: { code: "export_rate_limited", message: "You can export users once per minute. Wait, then retry." } },
  });
  router.get("/admin/users", async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try { res.json(await deps.admin.listUsers(parseUsersQuery(req.query))); } catch (err) { next(err); }
  });
  router.get("/admin/users/export.csv", limiter, async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (exporting) { res.status(503).set("Retry-After", "1").json({ error: { code: "users_export_busy", message: "Another Users export is still running. Retry shortly." } }); return; }
    exporting = true;
    const controller = new AbortController(), disconnected = () => controller.abort();
    res.once("close", disconnected);
    try {
      const prepared = await deps.admin.prepareUsersCsv({ ...parseUsersQuery(req.query, true), signal: controller.signal });
      controller.signal.throwIfAborted();
      // Audit only admission/count metadata, never email/Clerk IDs/search text.
      await deps.adminAudit?.audit(req, "users.export", null, { rows: Math.min(prepared.total, EXPORT_LIMIT), truncated: prepared.truncated });
      controller.signal.throwIfAborted();
      res.set("X-Export-Truncated", String(prepared.truncated));
      res.type("text/csv; charset=utf-8").attachment(`sc2tools-users-${new Date().toISOString().slice(0, 10)}.csv`);
      for await (const chunk of prepared.stream) {
        if (res.destroyed) break;
        if (!res.write(chunk)) await new Promise(resolve => {
          const ready = () => { res.off("drain", ready); res.off("close", ready); resolve(undefined); };
          res.once("drain", ready); res.once("close", ready);
        });
      }
      if (!res.destroyed) res.end();
    } catch (err) {
      if (!res.destroyed) { if (res.headersSent) res.destroy(/** @type {Error} */ (err)); else next(err); }
    } finally { res.off("close", disconnected); controller.abort(); exporting = false; }
  });
  return router;
}

module.exports = { buildAdminUsersRouter, parseUsersQuery };
