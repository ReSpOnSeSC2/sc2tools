"use strict";

const express = require("express");
const { MATCHUPS, failure } = require("../services/ghostTargets");

/** @param {{auth:import('express').RequestHandler,isAdmin:(req:any)=>boolean,examples:import('../services/ghostExamples').GhostExamplesService,references:import('../services/ghostReferences').GhostReferencesService}} deps */
function buildGhostBuildsRouter(deps) {
  const router = express.Router();
  const paths = ["/ghost-examples", "/me/ghost-builds", "/admin/ghost-examples"];
  router.use(paths, deps.auth, (req, res, next) => {
    if (!req.auth?.userId) return next(failure("auth_required", 401));
    res.set("Cache-Control", "private, no-store");
    next();
  });
  router.use("/admin/ghost-examples", (req, _res, next) => {
    if (req.auth?.source !== "clerk" || !deps.isAdmin(req)) return next(failure("admin_only", 403));
    next();
  });
  router.get("/ghost-examples", wrap(async (req, res) => {
    const matchup = typeof req.query.matchup === "string" ? req.query.matchup : undefined;
    if (matchup !== undefined && !MATCHUPS.has(matchup)) throw failure("invalid_ghost_matchup");
    res.json(await deps.examples.list({ matchup }));
  }));
  router.get("/ghost-examples/:id", wrap(async (req, res) => res.json(await deps.examples.get(String(req.params.id)))));
  router.get("/me/ghost-builds", wrap(async (req, res) => res.json(await deps.references.get(req.auth.userId))));
  router.get("/me/ghost-builds/comparison", wrap(async (req, res) => res.json(await deps.references.comparison(req.auth.userId, req.query))));
  router.put("/me/ghost-builds", wrap(async (req, res) => {
    validateBody(req.body, ["matchup", "target", "buildKey", "side"]);
    res.json(await deps.references.saveSlot(req.auth.userId, req.body));
  }));
  router.put("/me/ghost-builds/reference", wrap(async (req, res) => {
    validateBody(req.body, ["gameId", "side", "buildKey", "clear"]);
    if (req.body.clear !== undefined && typeof req.body.clear !== "boolean") throw failure("invalid_ghost_reference");
    res.json(await deps.references.reference(req.auth.userId, req.body));
  }));
  router.put("/me/ghost-builds/reference/restore", wrap(async (req, res) => {
    validateBody(req.body, ["referenceKey", "revision", "expectedCurrentRevision"]);
    res.json(await deps.references.restore(req.auth.userId, req.body));
  }));
  router.get("/admin/ghost-examples", wrap(async (req, res) => res.json(await deps.examples.list({ owner: req.auth.userId }))));
  router.post("/admin/ghost-examples/preview", wrap(async (req, res) => {
    validateBody(req.body, ["gameId", "side", "name", "description"]);
    res.json(await deps.examples.preview(req.auth.userId, req.body));
  }));
  router.post("/admin/ghost-examples", wrap(async (req, res) => {
    validateBody(req.body, ["gameId", "side", "name", "description", "previewToken"]);
    res.status(201).json(await deps.examples.publish(req.auth.userId, req.body));
  }));
  router.delete("/admin/ghost-examples/:id", wrap(async (req, res) => {
    await deps.examples.remove(req.auth.userId, String(req.params.id));
    res.status(204).end();
  }));
  return router;
}

/** @param {unknown} body @param {string[]} fields */
function validateBody(body, fields) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) throw failure("invalid_ghost_request");
}

/** @param {(req:any,res:any)=>Promise<any>} handler @returns {import('express').RequestHandler} */
function wrap(handler) { return (req, res, next) => { Promise.resolve(handler(req, res)).catch(next); }; }

module.exports = { buildGhostBuildsRouter };
