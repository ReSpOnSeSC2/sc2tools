"use strict";
const express = require("express");

/** Mounted beneath the shared authenticated admin/role gate.
 * @param {{studio:import('../services/adminBuildStudio').AdminBuildStudioService,policies:import('../services/presetPolicies').PresetPoliciesService}} deps */
function buildAdminBuildStudioRouter(deps) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  router.get("/", async (req, res, next) => {
    try {
      const scope = String(req.query.scope || "preset");
      res.json(await deps.studio.list(scope, { after: query(req.query.after, 200), owner: query(req.query.owner, 200) }));
    } catch (error) { next(error); }
  });
  router.get("/policy", async (_req, res, next) => { try { res.json(await deps.policies.current(true)); } catch (error) { next(error); } });
  router.get("/policy/history", async (req, res, next) => {
    try { res.json(await deps.policies.history(req.query.before === undefined ? undefined : Number(req.query.before))); } catch (error) { next(error); }
  });
  router.get("/policy/history/:revision", async (req, res, next) => {
    try { res.json(await deps.policies.revision(Number(req.params.revision))); } catch (error) { next(error); }
  });
  router.post("/policy/revert", async (req, res, next) => {
    res.locals.auditAction = "preset.policy.revert";
    try {
      if (!req.body || Object.keys(req.body).some((key) => !["expectedHash", "revision"].includes(key))) throw badQuery();
      const policy = await deps.policies.revert(req.body.expectedHash, req.body.revision);
      res.locals.auditResult = { revision: policy.revision };
      res.json(policy);
    } catch (error) { next(error); }
  });
  router.get("/:scope/:id", async (req, res, next) => {
    try { res.json(await deps.studio.detail(req.params.scope, req.params.id)); } catch (error) { next(error); }
  });
  router.put("/:scope/:id", async (req, res, next) => {
    res.locals.auditAction = req.params.scope === "preset" ? "preset.policy.save" : "user.build-definition.save";
    try {
      const current = await deps.studio.detail(req.params.scope, req.params.id);
      res.locals.auditTarget = current.owner || current.id;
      const result = await deps.studio.save(req.params.scope, req.params.id, req.body);
      res.locals.auditResult = { revision: result.policyRevision ?? result.revision };
      res.json(result);
    } catch (error) { next(error); }
  });
  router.post("/:scope/:id/revert", async (req, res, next) => {
    res.locals.auditAction = "user.build-definition.revert";
    try {
      const current = await deps.studio.detail(req.params.scope, req.params.id);
      res.locals.auditTarget = current.owner;
      if (!req.body || Object.keys(req.body).some((key) => !["expectedRevision", "revision"].includes(key))) throw badQuery();
      res.json(await deps.studio.revert(req.params.scope, req.params.id, req.body.expectedRevision, req.body.revision));
    } catch (error) { next(error); }
  });
  router.post("/preset/:id/preview", async (req, res, next) => {
    res.locals.auditAction = "preset.policy.preview";
    try {
      if (!req.body || Object.keys(req.body).some((key) => !["replacement", "events", "baseline"].includes(key))) throw badQuery();
      res.json(deps.studio.preview(req.params.id, req.body.replacement, req.body.events, req.body.baseline));
    } catch (error) { next(error); }
  });
  return router;
}
/** @param {unknown} value @param {number} max */
function query(value, max) { if (value === undefined) return undefined; if (typeof value !== "string" || !value || value.length > max) throw badQuery(); return value; }
function badQuery() { return Object.assign(new Error("invalid_build_studio_request"), { status: 400, code: "invalid_build_studio_request" }); }
module.exports = { buildAdminBuildStudioRouter };
